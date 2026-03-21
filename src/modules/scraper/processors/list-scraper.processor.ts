import { Logger } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { StockStoreService } from '../stock-store.service';

const JOB_OPTS = { attempts: 3, backoff: { type: 'fixed' as const, delay: 5_000 } };

const EGXPILOT_API = 'https://egxpilot.com/api/stocks/all';

interface EgxStock {
  Symbol: string;
  StockName: string;
  Sector: string | null;
  LastPrice: number;
  DailyChange: string;
  Recommendation: string;
}

@Processor('list-scraper')
export class ListScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ListScraperProcessor.name);

  constructor(
    private readonly stockStore: StockStoreService,
    private readonly prisma: PrismaService,
    @InjectQueue('detail-scraper') private readonly detailQueue: Queue,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    this.logger.log('list-scraper: job started');

    this.logger.log(`list-scraper: fetching ${EGXPILOT_API}`);
    const res = await fetch(EGXPILOT_API, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });

    if (!res.ok) throw new Error(`API returned ${res.status}`);

    const json = (await res.json()) as { updatedAt: string; stocks: EgxStock[] };
    const raw = json.stocks ?? [];

    const stocks = raw
      .filter((s) => s.Symbol)
      .map((s) => ({
        symbol: s.Symbol.trim(),
        name: s.StockName?.trim() || s.Symbol.trim(),
        sector: s.Sector?.trim() || 'Unknown',
      }));

    this.logger.log(`list-scraper: fetched ${stocks.length} stocks (updatedAt=${json.updatedAt})`);

    await this.stockStore.saveList(stocks);
    this.logger.log('list-scraper: saved symbol list to Redis market:list');

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
    this.logger.log(`list-scraper: upserted ${stocks.length} stocks into DB`);

    await this.detailQueue.add('fetch-sws-large-cap', {}, JOB_OPTS);
    this.logger.log('Enqueued SimplyWallSt large-cap detail scrape');
  }
}
