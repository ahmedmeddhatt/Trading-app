import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StockStoreService } from '../stock-store.service';
import { RedisWriterService } from '../redis-writer.service';
import { EgxpilotApiService } from '../services/egxpilot-api.service';
import { PRICES_UPDATED } from '../../../common/constants/event-names';

@Processor('price-scraper', { stalledInterval: 300_000, maxStalledCount: 1 })
export class PriceScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceScraperProcessor.name);

  constructor(
    private readonly stockStore: StockStoreService,
    private readonly redisWriter: RedisWriterService,
    private readonly eventEmitter: EventEmitter2,
    private readonly egxpilotApi: EgxpilotApiService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const existingList = await this.stockStore.getList();
    if (existingList.length === 0) {
      this.logger.warn('No stock list in Redis — skipping price scrape (waiting for list-scraper)');
      return;
    }

    this.logger.log('price-scraper: fetching live prices from EGXpilot API');
    const stocks = await this.egxpilotApi.fetchAllStocks();
    this.logger.log(`price-scraper: received ${stocks.length} prices`);

    let updated = 0;
    for (const stock of stocks) {
      const prevPrice = await this.stockStore.getPrevPrice(stock.symbol);
      const trending =
        prevPrice !== null ? Math.abs((stock.price - prevPrice) / prevPrice) > 0.03 : false;

      const now = Date.now();
      const payload = JSON.stringify({
        price: stock.price,
        changePercent: stock.changePercent,
        trending,
        timestamp: now,
        recommendation: stock.recommendation ?? null,
        signals: stock.signals ?? { daily: null, weekly: null, monthly: null },
      });

      await this.redisWriter.hset(stock.symbol, payload);
      await this.redisWriter.publish(
        'prices',
        JSON.stringify({
          symbol: stock.symbol,
          price: stock.price,
          changePercent: stock.changePercent,
          lastUpdate: new Date(now).toISOString(),
          recommendation: stock.recommendation ?? null,
          signals: stock.signals ?? { daily: null, weekly: null, monthly: null },
        }),
      );
      await this.stockStore.savePriceData(stock.symbol, stock.price, stock.changePercent, []);
      await this.stockStore.savePrevPrice(stock.symbol, stock.price);
      updated++;
    }

    const records = await this.stockStore.buildOutput();
    this.stockStore.writeFiles(records);

    this.eventEmitter.emit(PRICES_UPDATED, { count: updated, total: existingList.length });
    this.logger.log(`price-scraper: wrote ${updated} prices to market:prices`);
  }
}
