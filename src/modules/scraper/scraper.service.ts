import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

const JOB_OPTS = { attempts: 3, backoff: { type: 'fixed' as const, delay: 5_000 } };

@Injectable()
export class ScraperService implements OnModuleInit {
  private readonly logger = new Logger(ScraperService.name);

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

    // Price poll every 30 seconds
    await this.priceQueue.add('poll-prices', {}, {
      ...JOB_OPTS,
      repeat: { every: 30_000 },
    });

    this.logger.log('Scraper scheduled: list every 24h (+ immediate boot), prices every 30s');
  }
}
