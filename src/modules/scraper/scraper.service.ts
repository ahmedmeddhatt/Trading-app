import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { getMarketStatus, MarketStatus } from './utils/market-hours';

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'fixed' as const, delay: 5_000 },
  removeOnComplete: 3,
  removeOnFail: 5,
};

@Injectable()
export class ScraperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScraperService.name);
  private lastPriceScrape = 0;
  private priceInterval: NodeJS.Timeout;

  constructor(
    @InjectQueue('list-scraper') private readonly listQueue: Queue,
    @InjectQueue('price-scraper') private readonly priceQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // Daily list refresh
    await this.listQueue.add('fetch-list', {}, {
      ...JOB_OPTS,
      repeat: { every: 24 * 60 * 60 * 1_000 },
    });

    // Immediate first run for list
    await this.listQueue.add('fetch-list-boot', {}, JOB_OPTS);

    // Market-hours-aware price scraper: check every minute
    this.priceInterval = setInterval(() => void this.schedulePriceScraper(), 60_000);
    // Trigger once immediately on boot
    await this.schedulePriceScraper();

    this.logger.log('Scraper scheduled: list every 24h (+ immediate boot), prices market-hours-aware');
  }

  onModuleDestroy(): void {
    clearInterval(this.priceInterval);
  }

  private async schedulePriceScraper(): Promise<void> {
    const status = getMarketStatus();
    const intervalMs = this.getIntervalForStatus(status);
    const now = Date.now();

    if (now - this.lastPriceScrape >= intervalMs) {
      this.lastPriceScrape = now;
      await this.priceQueue.add('poll-prices', {}, JOB_OPTS);
      this.logger.log(
        `Price scrape triggered — market: ${status.label}, interval: ${intervalMs / 1000}s`,
      );
    }
  }

  private getIntervalForStatus(status: MarketStatus): number {
    if (status.isOpen)       return 30_000;
    if (status.isPreMarket)  return 300_000;
    if (status.isPostMarket) return 900_000;
    return 7_200_000; // 2h when fully closed / weekend
  }
}
