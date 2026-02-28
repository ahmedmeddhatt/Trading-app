import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PriceHistoryService } from '../price-history.service';

@Processor('archiver')
export class ArchiverProcessor extends WorkerHost {
  private readonly logger = new Logger(ArchiverProcessor.name);

  constructor(private readonly priceHistory: PriceHistoryService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    if (!this.isMarketHours()) {
      this.logger.debug('Outside market hours — skipping snapshot');
      return;
    }

    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setUTCDate(today.getUTCDate() + 30);

    await this.priceHistory.ensurePartitionExists(today);
    await this.priceHistory.ensurePartitionExists(nextMonth);

    this.logger.log('Running price snapshot archival...');
    await this.priceHistory.createSnapshots();
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
