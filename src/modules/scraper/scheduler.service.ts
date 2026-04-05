import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { StockStoreService } from './stock-store.service';
import { RedisWriterService } from './redis-writer.service';
import { PriceHistoryService } from './price-history.service';
import { StockMetadataService } from './stock-metadata.service';
import { PRICES_UPDATED } from '../../common/constants/event-names';
import type { PriceUpdate } from '../prices/redis-subscriber.service';

const EGXPILOT_API = 'https://egxpilot.com/api/stocks/all';
const MARKET_OPEN_MIN = 10 * 60;
const MARKET_CLOSE_MIN = 14 * 60 + 30;
const DELAY_MARKET_OPEN = 30_000;
const DELAY_MARKET_CLOSED = 2 * 60 * 60 * 1_000;
const LIST_INTERVAL = 24 * 60 * 60 * 1_000;
const ARCHIVER_INTERVAL = 60 * 60 * 1_000;

function cairominutes(): number {
  const now = new Date();
  return ((now.getUTCHours() + 2) % 24) * 60 + now.getUTCMinutes();
}

function isMarketOpen(): boolean {
  const m = cairominutes();
  return m >= MARKET_OPEN_MIN && m <= MARKET_CLOSE_MIN;
}

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private priceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly stockStore: StockStoreService,
    private readonly redisWriter: RedisWriterService,
    private readonly priceHistory: PriceHistoryService,
    private readonly stockMetadata: StockMetadataService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    // Ensure DB partitions exist for the current and next month on startup
    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setUTCDate(today.getUTCDate() + 30);
    void this.priceHistory.ensurePartitionExists(today).catch((e) =>
      this.logger.error(`startup partition init failed: ${(e as Error).message}`)
    );
    void this.priceHistory.ensurePartitionExists(nextMonth).catch((e) =>
      this.logger.error(`startup partition init failed: ${(e as Error).message}`)
    );

    // Start all loops
    void this.runPriceLoop();
    void this.runListScrape();
    setInterval(() => void this.runListScrape(), LIST_INTERVAL);
    void this.runArchiver();
    setInterval(() => void this.runArchiver(), ARCHIVER_INTERVAL);
  }

  // ─── Price scraper (self-chaining setTimeout) ─────────────────────────────

  async runPriceLoop(): Promise<void> {
    await this.fetchPrices(false);
    const delay = isMarketOpen() ? DELAY_MARKET_OPEN : DELAY_MARKET_CLOSED;
    this.priceTimer = setTimeout(() => void this.runPriceLoop(), delay);
  }

  async forcePriceScrape(): Promise<void> {
    if (this.priceTimer) { clearTimeout(this.priceTimer); this.priceTimer = null; }
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

      const json = (await res.json()) as { updatedAt: string; stocks: Array<{
        Symbol: string; LastPrice: number; DailyChange: string;
        Recommendation: string | null; Daily: string | null; Weekly: string | null; Monthly: string | null;
      }> };
      const raw = json.stocks ?? [];
      if (raw.length === 0) { this.logger.warn('price-scraper: API returned 0 stocks'); return; }

      const timestamp = new Date().toISOString();
      const hsetBatch: Record<string, string> = {};
      const publishBatch: PriceUpdate[] = [];

      for (const s of raw) {
        if (!s.Symbol || s.LastPrice == null) continue;
        const symbol = s.Symbol.trim();
        const price = s.LastPrice;
        const changePercent = parseFloat(s.DailyChange ?? '0') || 0;
        const prevPrice = this.stockStore.getPrevPrice(symbol);
        const trending = prevPrice !== null ? Math.abs((price - prevPrice) / prevPrice) > 0.03 : false;

        hsetBatch[symbol] = JSON.stringify({
          price, changePercent, trending, timestamp,
          recommendation: s.Recommendation ?? null,
          signals: { daily: s.Daily ?? null, weekly: s.Weekly ?? null, monthly: s.Monthly ?? null },
        });
        publishBatch.push({ symbol, price, changePercent, lastUpdate: timestamp,
          recommendation: s.Recommendation ?? null,
          signals: { daily: s.Daily ?? null, weekly: s.Weekly ?? null, monthly: s.Monthly ?? null },
        });
        this.stockStore.savePriceData(symbol, price, changePercent, []);
        this.stockStore.savePrevPrice(symbol, price);
      }

      if (publishBatch.length > 0) {
        await this.redisWriter.hsetMany(hsetBatch);
        // Emit in-process — no Redis pub/sub needed
        this.eventEmitter.emit(PRICES_UPDATED, { count: publishBatch.length, total: raw.length, updates: publishBatch });
      }

      const records = await this.stockStore.buildOutput();
      this.stockStore.writeFiles(records);
      this.logger.log(`price-scraper: wrote ${publishBatch.length} prices`);
    } catch (err) {
      this.logger.error(`price-scraper failed: ${(err as Error).message}`);
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

      const json = (await res.json()) as { updatedAt: string; stocks: Array<{
        Symbol: string; StockName: string; Sector: string | null;
      }> };
      const stocks = (json.stocks ?? [])
        .filter((s) => s.Symbol)
        .map((s) => ({ symbol: s.Symbol.trim(), name: s.StockName?.trim() || s.Symbol.trim(), sector: s.Sector?.trim() || 'Unknown' }));

      await this.stockStore.saveList(stocks);

      await this.prisma.$transaction(
        stocks.map((stock) =>
          this.prisma.stock.upsert({
            where: { symbol: stock.symbol },
            update: { name: stock.name },
            create: { symbol: stock.symbol, name: stock.name, sector: stock.sector, pe: null, marketCap: null },
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

  // ─── Archiver ─────────────────────────────────────────────────────────────

  async runArchiver(): Promise<void> {
    try {
      // Health check
      const raw = await this.redisWriter.hgetall('market:prices');
      const entries = Object.values(raw ?? {});
      if (entries.length > 0) {
        const fresh = entries.filter((j) => {
          try { const p = JSON.parse(j); return p?.timestamp && Date.now() - new Date(p.timestamp).getTime() <= 5 * 60_000; }
          catch { return false; }
        }).length;
        if (fresh === 0) this.logger.error('archiver: all prices are stale — price-scraper may be broken');
      }

      const today = new Date();
      const nextMonth = new Date(today);
      nextMonth.setUTCDate(today.getUTCDate() + 30);
      await this.priceHistory.ensurePartitionExists(today);
      await this.priceHistory.ensurePartitionExists(nextMonth);

      if (!isMarketOpen()) { this.logger.debug('archiver: outside market hours — skipping snapshot'); return; }

      await this.priceHistory.createSnapshots();
      this.logger.log('archiver: snapshot created');
    } catch (err) {
      this.logger.error(`archiver failed: ${(err as Error).message}`);
    }
  }
}
