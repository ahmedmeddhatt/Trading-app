import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ListScraperProcessor } from './processors/list-scraper.processor';
import { PriceScraperProcessor } from './processors/price-scraper.processor';

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: 10,
  removeOnFail: 50,
};

/** Cairo time is UTC+2. Market hours: 10:00–14:30 */
function isMarketHours(): boolean {
  const now = new Date();
  const cairoHour = (now.getUTCHours() + 2) % 24;
  const cairoMinute = now.getUTCMinutes();
  const totalMinutes = cairoHour * 60 + cairoMinute;
  return totalMinutes >= 10 * 60 && totalMinutes <= 14 * 60 + 30;
}

@Injectable()
export class ScraperService implements OnModuleInit {
  private readonly logger = new Logger(ScraperService.name);

  constructor(
    @InjectQueue('list-scraper') private readonly listQueue: Queue,
    @InjectQueue('price-scraper') private readonly priceQueue: Queue,
    @InjectQueue('archiver') private readonly archiverQueue: Queue,
    private readonly listScraperProcessor: ListScraperProcessor,
    private readonly priceScraperProcessor: PriceScraperProcessor,
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = process.env.REDIS_URL ?? '';
    this.logger.log(`Redis protocol: ${redisUrl.split('://')[0] || 'NOT SET'}`);

    // Resume queues if they were auto-paused by BullMQ after repeated failures
    await this.resumeIfPaused(this.listQueue, 'list-scraper');
    await this.resumeIfPaused(this.priceQueue, 'price-scraper');

    // Daily list refresh
    await this.listQueue.add('fetch-list', {}, {
      ...JOB_OPTS,
      repeat: { every: 24 * 60 * 60 * 1_000 },
    });

    // Immediate first run for list (queued)
    await this.listQueue.add('fetch-list-boot', {}, JOB_OPTS);
    this.logger.log('Boot list-scrape job enqueued — waiting for processor to pick up');

    // Log queue states for visibility
    const listWaiting = await this.listQueue.getWaitingCount();
    const listActive = await this.listQueue.getActiveCount();
    const listFailed = await this.listQueue.getFailedCount();
    this.logger.log(`list-scraper queue on boot: waiting=${listWaiting} active=${listActive} failed=${listFailed}`);

    // Price poll every 30 seconds
    await this.priceQueue.add('poll-prices', {}, {
      ...JOB_OPTS,
      repeat: { every: 30_000 },
    });

    // Hourly price archival (market hours only)
    await this.archiverQueue.add('archive-prices', {}, {
      ...JOB_OPTS,
      repeat: { every: 60 * 60 * 1_000 },
    });

    // Immediate archive on boot if market is open
    if (isMarketHours()) {
      await this.archiverQueue.add('archive-prices-boot', {}, JOB_OPTS);
    }

    this.logger.log('Scraper scheduled: list every 24h, prices every 30s, archiver every 1h');

    // Direct boot scrape — bypasses queue, runs synchronously once on startup
    try {
      this.logger.log('Running direct boot list scrape...');
      await this.listScraperProcessor.process({ id: 'boot-direct' } as any);
      this.logger.log('Direct boot list scrape completed');
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Direct boot list scrape failed');
    }

    try {
      this.logger.log('Running direct boot price scrape...');
      await this.priceScraperProcessor.process({ id: 'boot-price' } as any);
      this.logger.log('Direct boot price scrape completed');
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Direct boot price scrape failed');
    }
  }

  private async resumeIfPaused(queue: Queue, name: string): Promise<void> {
    const isPaused = await queue.isPaused();
    if (isPaused) {
      this.logger.warn(`${name} queue was paused — resuming`);
      await queue.resume();
    }
  }
}
