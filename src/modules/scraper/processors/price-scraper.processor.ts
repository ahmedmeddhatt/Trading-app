import { Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StockStoreService } from '../stock-store.service';
import { RedisWriterService } from '../redis-writer.service';
import { PRICES_UPDATED } from '../../../common/constants/event-names';

const EGXPILOT_API = 'https://egxpilot.com/api/stocks/all';
const MARKET_OPEN_MIN = 10 * 60;
const MARKET_CLOSE_MIN = 14 * 60 + 30;
const DELAY_MARKET_OPEN = 30_000;
const DELAY_MARKET_CLOSED = 2 * 60 * 60 * 1_000;

interface EgxStock {
  Symbol: string;
  LastPrice: number;
  DailyChange: string;
  Recommendation: string | null;
  Daily: string | null;
  Weekly: string | null;
  Monthly: string | null;
}

@Processor('price-scraper')
export class PriceScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceScraperProcessor.name);

  constructor(
    private readonly stockStore: StockStoreService,
    private readonly redisWriter: RedisWriterService,
    private readonly eventEmitter: EventEmitter2,
    @InjectQueue('price-scraper') private readonly priceQueue: Queue,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    this.logger.log('price-scraper: job started');

    const force: boolean = _job.data?.force === true;

    const now = new Date();
    const cairoMinutes =
      ((now.getUTCHours() + 2) % 24) * 60 + now.getUTCMinutes();
    const isMarketOpen =
      cairoMinutes >= MARKET_OPEN_MIN && cairoMinutes <= MARKET_CLOSE_MIN;
    const nextDelay = isMarketOpen ? DELAY_MARKET_OPEN : DELAY_MARKET_CLOSED;

    if (!force && !isMarketOpen) {
      this.logger.log('price-scraper: outside market hours — next run in 2h');
      await this.priceQueue.add(
        'fetch-prices',
        {},
        { delay: nextDelay, removeOnComplete: 10, removeOnFail: 50 },
      );
      return;
    }
    if (force)
      this.logger.log(
        'price-scraper: forced run — bypassing market hours guard',
      );

    try {
      this.logger.log(`price-scraper: fetching ${EGXPILOT_API}`);
      const res = await fetch(EGXPILOT_API, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });

      if (!res.ok) throw new Error(`API returned ${res.status}`);

      const json = (await res.json()) as {
        updatedAt: string;
        stocks: EgxStock[];
      };
      const raw = json.stocks ?? [];

      if (raw.length === 0) {
        this.logger.warn(
          'price-scraper: API returned 0 stocks — retrying in 60s',
        );
        if (!force)
          await this.priceQueue.add(
            'fetch-prices',
            {},
            { delay: 60_000, removeOnComplete: 10, removeOnFail: 50 },
          );
        return;
      }

      const timestamp = new Date().toISOString();
      const hsetBatch: Record<string, string> = {};
      const publishBatch: {
        symbol: string;
        price: number;
        changePercent: number;
        lastUpdate: string;
      }[] = [];

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
        });
        this.stockStore.savePriceData(symbol, price, changePercent, []);
        this.stockStore.savePrevPrice(symbol, price);
      }

      const updated = publishBatch.length;
      if (updated > 0) {
        await this.redisWriter.hsetMany(hsetBatch);
        await this.redisWriter.publish('prices', JSON.stringify(publishBatch));
      }

      this.logger.log(
        `price-scraper: wrote ${updated} prices (API updatedAt=${json.updatedAt})`,
      );

      const records = await this.stockStore.buildOutput();
      this.stockStore.writeFiles(records);

      this.eventEmitter.emit(PRICES_UPDATED, {
        count: updated,
        total: raw.length,
      });

      if (!force) {
        await this.priceQueue.add(
          'fetch-prices',
          {},
          { delay: nextDelay, removeOnComplete: 10, removeOnFail: 50 },
        );
      }
    } catch (error) {
      this.logger.error(
        {
          event: 'SCRAPER_FAILED',
          processor: 'price-scraper',
          error: (error as Error).message,
        },
        'Scraper job failed',
      );
      if (!force) {
        await this.priceQueue.add(
          'fetch-prices',
          {},
          { delay: nextDelay, removeOnComplete: 10, removeOnFail: 50 },
        );
      }
      throw error;
    }
  }
}
