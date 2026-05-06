import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TrackerService } from './tracker.service';

const CHECK_INTERVAL = 10 * 60 * 1_000; // every 10 min
const EVAL_INTERVAL = 6 * 60 * 60 * 1_000; // every 6 h
const SNAPSHOT_HOUR_CAIRO = 9; // 09:00 Cairo
// Daily mode: capture every day at 09:00 (after the 08:00 generation has settled).

function cairoNow(): { hours: number; dateKey: string } {
  const now = new Date();
  // Cairo = UTC+2 (no DST since 2014)
  const cairo = new Date(now.getTime() + 2 * 60 * 60 * 1_000);
  return {
    hours: cairo.getUTCHours(),
    dateKey: cairo.toISOString().slice(0, 10),
  };
}

@Injectable()
export class TrackerScheduler implements OnModuleInit {
  private readonly logger = new Logger(TrackerScheduler.name);
  private lastSnapshotDayKey: string | null = null;

  constructor(private readonly tracker: TrackerService) {}

  onModuleInit(): void {
    setInterval(() => void this.checkDailySnapshot(), CHECK_INTERVAL);
    setInterval(() => void this.runEvaluation(), EVAL_INTERVAL);
    // Initial passes on boot — evaluation primes the cache so the page is "ready" immediately.
    void this.checkDailySnapshot();
    void this.runEvaluation();
  }

  private async checkDailySnapshot(): Promise<void> {
    const { hours, dateKey } = cairoNow();
    if (hours !== SNAPSHOT_HOUR_CAIRO) return;

    if (this.lastSnapshotDayKey === dateKey) return;

    try {
      const result = await this.tracker.captureSnapshot();
      this.lastSnapshotDayKey = dateKey;
      this.logger.log(
        `tracker: daily snapshot captured (${result.aiProvider}/${result.aiModel}, ${result.pickCount} picks${result.alreadyExisted ? ', already existed' : ''})`,
      );
    } catch (err) {
      this.logger.warn(
        `tracker: daily snapshot failed — ${(err as Error).message}`,
      );
    }
  }

  private async runEvaluation(): Promise<void> {
    try {
      const result = await this.tracker.evaluateAllActive();
      if (result.evaluated > 0) {
        this.logger.log(
          `tracker: scheduled eval — ${result.evaluated} evaluated, ${result.closed} closed`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `tracker: scheduled eval failed — ${(err as Error).message}`,
      );
    }
    // Self-heal: pick up any AR payload that landed in weekly_picks_log
    // after the EN snapshot was already captured.
    try {
      await this.tracker.backfillArPayloads();
    } catch (err) {
      this.logger.warn(
        `tracker: AR backfill failed — ${(err as Error).message}`,
      );
    }
  }
}
