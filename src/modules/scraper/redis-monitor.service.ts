import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

@Injectable()
export class RedisMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisMonitorService.name);
  private requestCount = 0;
  private readonly sessionStart = Date.now();
  private statsInterval: NodeJS.Timeout;

  onModuleInit(): void {
    // Log stats every hour
    this.statsInterval = setInterval(() => this.logStats(), 60 * 60 * 1_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.statsInterval);
  }

  increment(operation: string): void {
    void operation;
    this.requestCount++;

    if (this.requestCount === 120_000) {
      this.logger.warn(
        {
          event: 'REDIS_QUOTA_WARNING',
          requests: this.requestCount,
          limit: 150_000,
          percentUsed: 80,
          sessionDurationHours: (Date.now() - this.sessionStart) / 3_600_000,
        },
        'Upstash request count at 80% of 150k monthly limit',
      );
    }

    if (this.requestCount === 140_000) {
      this.logger.error(
        {
          event: 'REDIS_QUOTA_CRITICAL',
          requests: this.requestCount,
          limit: 150_000,
        },
        'CRITICAL: Upstash requests at 93% of 150k monthly limit',
      );
    }
  }

  logStats(): void {
    const hoursSinceStart = (Date.now() - this.sessionStart) / 3_600_000;
    const ratePerHour = this.requestCount / Math.max(hoursSinceStart, 1);
    const projectedMonthly = ratePerHour * 24 * 30;

    this.logger.log(
      {
        event: 'REDIS_USAGE_STATS',
        sessionRequests: this.requestCount,
        ratePerHour: Math.round(ratePerHour),
        projectedMonthly: Math.round(projectedMonthly),
        monthlyLimit: 150_000,
        projectedUsagePercent: Math.round((projectedMonthly / 150_000) * 100),
      },
      'Redis usage stats',
    );

    if (projectedMonthly > 120_000) {
      this.logger.warn(
        `Redis projected monthly usage: ${Math.round(projectedMonthly)} ` +
          `(${Math.round((projectedMonthly / 150_000) * 100)}% of limit). ` +
          `Check for unexpected polling.`,
      );
    }
  }
}
