import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { GeminiAnalysisService } from './services/gemini-analysis.service';
import { PrismaService } from '../../database/prisma.service';
import { RedisWriterService } from './redis-writer.service';

const CHECK_INTERVAL_MS = 10 * 60 * 1_000; // every 10 min
const RUN_HOUR_CAIRO = 8; // 08:00 Cairo (before market open at 10:00)

function cairoNow(): { hours: number; dateKey: string } {
  const now = new Date();
  const cairo = new Date(now.getTime() + 2 * 60 * 60 * 1_000); // UTC+2, no DST since 2014
  return {
    hours: cairo.getUTCHours(),
    dateKey: cairo.toISOString().slice(0, 10),
  };
}

/**
 * Daily multi-provider weekly-picks generation.
 *
 * Trips once per Cairo calendar day at 08:00 (well before the 10:00 market open).
 * Generates EN picks via the parallel multi-provider chain, then translates to AR.
 * Both payloads are written to Redis (`ai:daily-picks:{lang}:{date}`) and to the
 * durable `weekly_picks_log` table; the tracker scheduler picks them up at 09:30.
 *
 * Behind the `DAILY_RECS_ENABLED` env flag so it can be rolled back instantly.
 */
@Injectable()
export class DailyPicksScheduler implements OnModuleInit {
  private readonly logger = new Logger(DailyPicksScheduler.name);
  private lastRunDayKey: string | null = null;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly geminiAnalysis: GeminiAnalysisService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisWriterService,
  ) {
    this.enabled = this.config.get<string>('DAILY_RECS_ENABLED') === 'true';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'DailyPicksScheduler: DAILY_RECS_ENABLED=false — generation disabled',
      );
      return;
    }
    setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    void this.tick(); // initial check on boot — fires only if 08:00 today and not already run
  }

  private async tick(): Promise<void> {
    const { hours, dateKey } = cairoNow();
    if (hours !== RUN_HOUR_CAIRO) return;
    if (this.lastRunDayKey === dateKey) return;

    this.logger.log(
      `DailyPicksScheduler: triggering daily generation for ${dateKey}`,
    );
    try {
      await this.generateAndCache('en');
      // AR translation reuses the EN AI call, so only the same providers per day
      await this.generateAndCacheAr();
      this.lastRunDayKey = dateKey;
      this.logger.log(
        `DailyPicksScheduler: daily generation complete for ${dateKey}`,
      );
    } catch (err) {
      this.logger.error(
        `DailyPicksScheduler: generation failed for ${dateKey} — ${(err as Error).message}`,
      );
      // Don't set lastRunDayKey on failure so the next tick (10 min later) retries
      // until the hour rolls over.
    }
  }

  private async generateAndCache(lang: 'en' | 'ar'): Promise<void> {
    const result = await this.geminiAnalysis.generateWeeklyPicks(lang);
    await this.prisma.weeklyPicksLog
      .create({
        data: {
          generatedAt: new Date(result.generatedAt),
          expiresAt: new Date(result.expiresAt),
          lang,
          aiProvider: result.aiProvider,
          aiModel: result.aiModel,
          marketCondition: result.marketCondition,
          payload: result as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `weekly-picks-log write failed: ${(err as Error).message}`,
        ),
      );

    const json = JSON.stringify(result);
    const today = cairoNow().dateKey;
    await this.redis
      .set(`ai:daily-picks:${lang}:${today}`, json, 'EX', 36 * 60 * 60)
      .catch(() => {});
    await this.redis
      .set(`ai:daily-picks:${lang}:last-good`, json)
      .catch(() => {});
  }

  private async generateAndCacheAr(): Promise<void> {
    // Read latest EN payload from log and translate. Mirrors the controller's
    // GET /api/stocks/weekly-picks/translate-ar logic without the HTTP layer.
    const enLog = await this.prisma.weeklyPicksLog.findFirst({
      where: { lang: 'en' },
      orderBy: { generatedAt: 'desc' },
    });
    if (!enLog) {
      this.logger.warn(
        'DailyPicksScheduler: no EN payload available for AR translation',
      );
      return;
    }
    const enPayload = enLog.payload as unknown as Parameters<
      GeminiAnalysisService['translateWeeklyPicksToArabic']
    >[0];

    const translated =
      await this.geminiAnalysis.translateWeeklyPicksToArabic(enPayload);
    // Timestamps come from the durable log row (generatedAt/expiresAt aren't on
    // the narrow translateWeeklyPicksToArabic input/output types).
    const arPayload = {
      generatedAt: enLog.generatedAt.toISOString(),
      expiresAt: enLog.expiresAt.toISOString(),
      aiProvider: translated.aiProvider,
      aiModel: translated.aiModel,
      marketCondition: translated.marketCondition,
      picks: translated.picks,
      top3Summary: translated.top3Summary,
      allocationAdvice: translated.allocationAdvice,
      providers: (enPayload as { providers?: unknown }).providers,
    };

    await this.prisma.weeklyPicksLog
      .create({
        data: {
          generatedAt: enLog.generatedAt,
          expiresAt: enLog.expiresAt,
          lang: 'ar',
          aiProvider: arPayload.aiProvider,
          aiModel: arPayload.aiModel,
          marketCondition: arPayload.marketCondition,
          payload: arPayload as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `AR translation log write failed: ${(err as Error).message}`,
        ),
      );

    const json = JSON.stringify(arPayload);
    const today = cairoNow().dateKey;
    await this.redis
      .set(`ai:daily-picks:ar:${today}`, json, 'EX', 36 * 60 * 60)
      .catch(() => {});
    await this.redis.set('ai:daily-picks:ar:last-good', json).catch(() => {});
  }
}
