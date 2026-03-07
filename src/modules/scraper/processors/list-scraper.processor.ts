import { Logger } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { StockStoreService } from '../stock-store.service';
import { EgxpilotApiService } from '../services/egxpilot-api.service';

const JOB_OPTS = { attempts: 3, backoff: { type: 'fixed' as const, delay: 5_000 } };

@Processor('list-scraper', { stalledInterval: 300_000, maxStalledCount: 1 })
export class ListScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ListScraperProcessor.name);

  constructor(
    private readonly stockStore: StockStoreService,
    private readonly egxpilotApi: EgxpilotApiService,
    private readonly prisma: PrismaService,
    @InjectQueue('detail-scraper') private readonly detailQueue: Queue,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    this.logger.log('list-scraper: fetching stock list from EGXpilot API');

    let stocks: Awaited<ReturnType<EgxpilotApiService['fetchAllStocks']>>;
    try {
      stocks = await this.egxpilotApi.fetchAllStocks();
    } catch (err) {
      this.logger.error(`list-scraper: API fetch failed: ${(err as Error).message}`);
      throw err;
    }

    this.logger.log(`list-scraper: received ${stocks.length} stocks from API`);

    await this.stockStore.saveList(
      stocks.map((s) => ({ symbol: s.symbol, name: s.name, sector: s.sector })),
    );
    this.logger.log(`list-scraper: saved ${stocks.length} symbols to market:list`);

    let upsertCount = 0;
    for (const stock of stocks) {
      await this.prisma.stock.upsert({
        where: { symbol: stock.symbol },
        update: { name: stock.name, sector: stock.sector ?? 'Unknown' },
        create: { symbol: stock.symbol, name: stock.name, sector: stock.sector ?? 'Unknown', pe: null, marketCap: null },
      });
      upsertCount++;
    }
    this.logger.log(`list-scraper: upserted ${upsertCount} stocks into DB`);

    // Enqueue SimplyWallSt large-cap detail scrape
    await this.detailQueue.add('fetch-sws-large-cap', {}, JOB_OPTS);
    this.logger.log('Enqueued SimplyWallSt large-cap detail scrape');
  }
}
