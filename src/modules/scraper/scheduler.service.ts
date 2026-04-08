import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { StockStoreService } from './stock-store.service';
import { RedisWriterService } from './redis-writer.service';
import { PriceHistoryService } from './price-history.service';
import { GoldPriceHistoryService } from './gold-price-history.service';
import { GoldScraperService } from './services/gold-scraper.service';
import { StockMetadataService } from './stock-metadata.service';
import {
  PRICES_UPDATED,
  GOLD_PRICES_UPDATED,
} from '../../common/constants/event-names';
import type { PriceUpdate } from '../prices/redis-subscriber.service';

const EGXPILOT_API = 'https://egxpilot.com/api/stocks/all';
const MARKET_OPEN_MIN = 10 * 60;
const MARKET_CLOSE_MIN = 14 * 60 + 30;
const DELAY_MARKET_OPEN = 30_000;
const DELAY_MARKET_CLOSED = 2 * 60 * 60 * 1_000;
const LIST_INTERVAL = 24 * 60 * 60 * 1_000;
const DAILY_ARCHIVE_HOUR = 15; // 3 PM Cairo time (after market close at 14:30)

// Gold scraper intervals
const GOLD_DELAY_ACTIVE = 10 * 60 * 1_000; // 10 minutes during 09:00-22:00
const GOLD_DELAY_INACTIVE = 60 * 60 * 1_000; // 1 hour off-hours
const GOLD_ACTIVE_START = 9 * 60; // 09:00 Cairo
const GOLD_ACTIVE_END = 22 * 60; // 22:00 Cairo

function cairoTime(): { hours: number; minutes: number; totalMinutes: number } {
  const now = new Date();
  const hours = (now.getUTCHours() + 2) % 24;
  const minutes = now.getUTCMinutes();
  return { hours, minutes, totalMinutes: hours * 60 + minutes };
}

function isMarketOpen(): boolean {
  const { totalMinutes } = cairoTime();
  return totalMinutes >= MARKET_OPEN_MIN && totalMinutes <= MARKET_CLOSE_MIN;
}

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private priceTimer: ReturnType<typeof setTimeout> | null = null;
  private goldTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private firstPriceScrapeArchived = false;
  private firstGoldScrapeArchived = false;
  private lastArchiveDate: string | null = null;
  private lastGoldArchiveDate: string | null = null;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly stockStore: StockStoreService,
    private readonly redisWriter: RedisWriterService,
    private readonly priceHistory: PriceHistoryService,
    private readonly stockMetadata: StockMetadataService,
    private readonly goldScraper: GoldScraperService,
    private readonly goldPriceHistory: GoldPriceHistoryService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    // Start all loops
    void this.runPriceLoop();
    void this.runGoldPriceLoop();
    void this.runListScrape();
    setInterval(() => void this.runListScrape(), LIST_INTERVAL);
    // Check for daily archive every 10 minutes (low Redis overhead — no Redis call unless it's time)
    setInterval(() => void this.checkDailyArchive(), 10 * 60 * 1_000);
    void this.checkDailyArchive();
  }

  // ─── Price scraper (self-chaining setTimeout) ─────────────────────────────

  async runPriceLoop(): Promise<void> {
    await this.fetchPrices(false);
    const delay = isMarketOpen() ? DELAY_MARKET_OPEN : DELAY_MARKET_CLOSED;
    this.priceTimer = setTimeout(() => void this.runPriceLoop(), delay);
  }

  async forcePriceScrape(): Promise<void> {
    if (this.priceTimer) {
      clearTimeout(this.priceTimer);
      this.priceTimer = null;
    }
    await this.fetchPrices(true);
    const delay = isMarketOpen() ? DELAY_MARKET_OPEN : DELAY_MARKET_CLOSED;
    this.priceTimer = setTimeout(() => void this.runPriceLoop(), delay);
  }

  private async fetchPrices(force: boolean): Promise<void> {
    if (!force && !isMarketOpen()) {
      this.logger.log('price-scraper: outside market hours — skipping');
      return;
    }
    try {
      this.logger.log('price-scraper: fetching prices');
      const res = await fetch(EGXPILOT_API, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);

      const json = (await res.json()) as {
        updatedAt: string;
        stocks: Array<{
          Symbol: string;
          LastPrice: number;
          DailyChange: string;
          Recommendation: string | null;
          Daily: string | null;
          Weekly: string | null;
          Monthly: string | null;
        }>;
      };
      const raw = json.stocks ?? [];
      if (raw.length === 0) {
        this.logger.warn('price-scraper: API returned 0 stocks');
        return;
      }

      const timestamp = new Date().toISOString();
      const hsetBatch: Record<string, string> = {};
      const publishBatch: PriceUpdate[] = [];

      for (const s of raw) {
        if (!s.Symbol || s.LastPrice == null) continue;
        const symbol = s.Symbol.trim();
        const price = s.LastPrice;
        const changePercent = parseFloat(s.DailyChange ?? '0') || 0;
        const prevPrice = this.stockStore.getPrevPrice(symbol);
        const trending =
          prevPrice !== null
            ? Math.abs((price - prevPrice) / prevPrice) > 0.03
            : false;

        hsetBatch[symbol] = JSON.stringify({
          price,
          changePercent,
          trending,
          timestamp,
          recommendation: s.Recommendation ?? null,
          signals: {
            daily: s.Daily ?? null,
            weekly: s.Weekly ?? null,
            monthly: s.Monthly ?? null,
          },
        });
        publishBatch.push({
          symbol,
          price,
          changePercent,
          lastUpdate: timestamp,
          recommendation: s.Recommendation ?? null,
          signals: {
            daily: s.Daily ?? null,
            weekly: s.Weekly ?? null,
            monthly: s.Monthly ?? null,
          },
        });
        this.stockStore.savePriceData(symbol, price, changePercent, []);
        this.stockStore.savePrevPrice(symbol, price);
      }

      if (publishBatch.length > 0) {
        await this.redisWriter.hsetMany(hsetBatch);
        // Emit in-process — no Redis pub/sub needed
        this.eventEmitter.emit(PRICES_UPDATED, {
          count: publishBatch.length,
          total: raw.length,
          updates: publishBatch,
        });
      }

      const records = await this.stockStore.buildOutput();
      this.stockStore.writeFiles(records);
      this.logger.log(`price-scraper: wrote ${publishBatch.length} prices`);

      // On first successful scrape, immediately archive to seed price history
      if (!this.firstPriceScrapeArchived && publishBatch.length > 0) {
        this.firstPriceScrapeArchived = true;
        void this.runArchiver().catch(() => {});
      }
    } catch (err) {
      this.logger.error(`price-scraper failed: ${(err as Error).message}`);
    }
  }

  // ─── Gold price scraper (self-chaining setTimeout) ────────────────────────

  async runGoldPriceLoop(): Promise<void> {
    await this.fetchGoldPrices();
    const { totalMinutes } = cairoTime();
    const isActive =
      totalMinutes >= GOLD_ACTIVE_START && totalMinutes <= GOLD_ACTIVE_END;
    const delay = isActive ? GOLD_DELAY_ACTIVE : GOLD_DELAY_INACTIVE;
    this.goldTimer = setTimeout(() => void this.runGoldPriceLoop(), delay);
  }

  private async fetchGoldPrices(): Promise<void> {
    try {
      this.logger.log('gold-scraper: fetching gold prices');
      const prices = await this.goldScraper.fetchPrices();
      if (prices.length === 0) {
        this.logger.warn('gold-scraper: no prices returned');
        return;
      }

      // Write to Redis
      const hsetBatch: Record<string, string> = {};
      for (const p of prices) {
        hsetBatch[p.categoryId] = JSON.stringify({
          buyPrice: p.buyPrice,
          sellPrice: p.sellPrice,
          changePercent: p.changePercent,
          timestamp: p.timestamp,
          source: p.source,
          globalSpotUsd: p.globalSpotUsd,
        });
      }
      await this.redisWriter.hsetMany(hsetBatch, 'market:gold:prices');

      // Emit event for SSE subscribers
      this.eventEmitter.emit(GOLD_PRICES_UPDATED, {
        count: prices.length,
        updates: prices,
      });

      this.logger.log(`gold-scraper: wrote ${prices.length} gold prices`);

      // Archive on first successful scrape
      if (!this.firstGoldScrapeArchived && prices.length > 0) {
        this.firstGoldScrapeArchived = true;
        void this.runGoldArchiver().catch(() => {});
      }
    } catch (err) {
      this.logger.error(`gold-scraper failed: ${(err as Error).message}`);
    }
  }

  private async runGoldArchiver(): Promise<void> {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (this.lastGoldArchiveDate === todayStr) return;
    try {
      const count = await this.goldPriceHistory.createDailySnapshot();
      this.lastGoldArchiveDate = todayStr;
      this.logger.log(
        `gold-archiver: daily snapshot created (${count} records)`,
      );
    } catch (err) {
      this.logger.error(`gold-archiver failed: ${(err as Error).message}`);
    }
  }

  // ─── List scraper ─────────────────────────────────────────────────────────

  async runListScrape(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.logger.log('list-scraper: fetching stock list');
      const res = await fetch(EGXPILOT_API, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`API returned ${res.status}`);

      const json = (await res.json()) as {
        updatedAt: string;
        stocks: Array<{
          Symbol: string;
          StockName: string;
          Sector: string | null;
        }>;
      };
      const stocks = (json.stocks ?? [])
        .filter((s) => s.Symbol)
        .map((s) => ({
          symbol: s.Symbol.trim(),
          name: s.StockName?.trim() || s.Symbol.trim(),
          sector: s.Sector?.trim() || 'Unknown',
        }));

      await this.stockStore.saveList(stocks);

      await this.prisma.$transaction(
        stocks.map((stock) =>
          this.prisma.stock.upsert({
            where: { symbol: stock.symbol },
            update: { name: stock.name },
            create: {
              symbol: stock.symbol,
              name: stock.name,
              sector: stock.sector,
              pe: null,
              marketCap: null,
            },
          }),
        ),
      );
      this.logger.log(`list-scraper: saved ${stocks.length} stocks`);
    } catch (err) {
      this.logger.error(`list-scraper failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  // ─── Daily Archiver ────────────────────────────────────────────────────────

  /**
   * Checks if it's time for the daily snapshot (once per day after market close).
   * Only hits Redis when it's actually time to archive — the time check is pure CPU.
   */
  private async checkDailyArchive(): Promise<void> {
    const { hours } = cairoTime();
    const todayStr = new Date().toISOString().slice(0, 10);

    // Already archived today
    if (this.lastArchiveDate === todayStr) return;

    // EGX is closed on Friday (day 5) and Saturday (day 6)
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 5 || dayOfWeek === 6) return;

    // Only archive after the configured hour (market closes at 14:30, archive at 15:00)
    if (hours < DAILY_ARCHIVE_HOUR) return;

    await this.runArchiver();
    await this.runGoldArchiver();
  }

  async runArchiver(): Promise<void> {
    const todayStr = new Date().toISOString().slice(0, 10);
    // Prevent duplicate archives for same day (first-scrape + daily check)
    if (this.lastArchiveDate === todayStr) return;

    try {
      const count = await this.priceHistory.createDailySnapshot();
      this.lastArchiveDate = todayStr;
      this.logger.log(`archiver: daily snapshot created (${count} records)`);
    } catch (err) {
      this.logger.error(`archiver failed: ${(err as Error).message}`);
    }
  }
}
