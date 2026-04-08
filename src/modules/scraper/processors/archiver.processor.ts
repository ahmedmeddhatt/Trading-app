import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PriceHistoryService } from '../price-history.service';
import { RedisWriterService } from '../redis-writer.service';

const STALE_MS = 5 * 60 * 1000;

@Processor('archiver')
export class ArchiverProcessor extends WorkerHost {
  private readonly logger = new Logger(ArchiverProcessor.name);

  constructor(
    private readonly priceHistory: PriceHistoryService,
    private readonly redisWriter: RedisWriterService,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.checkPriceHealth();

    if (!this.isMarketHours()) {
      this.logger.debug('Outside market hours — skipping snapshot');
      return;
    }

    this.logger.log('Running price snapshot archival...');
    await this.priceHistory.createDailySnapshot();
  }

  private async checkPriceHealth(): Promise<void> {
    const raw = await this.redisWriter.hgetall('market:prices');
    const entries = Object.values(raw ?? {});
    if (!entries.length) return;

    const now = Date.now();
    let fresh = 0;
    let oldestUpdate: string | null = null;

    for (const json of entries) {
      try {
        const parsed = JSON.parse(json);
        if (!parsed?.timestamp) continue;
        const age = now - new Date(parsed.timestamp).getTime();
        if (age <= STALE_MS) fresh++;
        if (!oldestUpdate || parsed.timestamp < oldestUpdate) oldestUpdate = parsed.timestamp;
      } catch { /* skip */ }
    }

    if (fresh === 0) {
      this.logger.error({
        event: 'PRICES_DEAD',
        symbolsTotal: entries.length,
        symbolsWithFreshPrice: 0,
        oldestUpdate,
        message: 'All prices are stale — price-scraper is likely broken',
      });
    }
  }

  /** Cairo time is UTC+2. Market hours: 10:00–14:30 */
  private isMarketHours(): boolean {
    const now = new Date();
    const cairoHour = (now.getUTCHours() + 2) % 24;
    const cairoMinute = now.getUTCMinutes();
    const totalMinutes = cairoHour * 60 + cairoMinute;
    return totalMinutes >= 10 * 60 && totalMinutes <= 14 * 60 + 30;
  }
}
