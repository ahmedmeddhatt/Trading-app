import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

// Hit-detection note: stock_price_history archives only the daily close price
// (no high/low). We use close-cross detection: a level is hit on the first
// archived day where close crosses it. If intraday OHLC becomes available
// later, the same logic generalizes by replacing close with high/low.

const STATUS = {
  PENDING: 'PENDING',
  ENTERED: 'ENTERED',
  T1_HIT: 'T1_HIT',
  T2_HIT: 'T2_HIT',
  STOPPED: 'STOPPED',
  EXPIRED: 'EXPIRED',
} as const;

type StatusValue = (typeof STATUS)[keyof typeof STATUS];

interface PickPayload {
  rank: number;
  symbol: string;
  company: string;
  sector: string;
  currentPrice: number;
  status: string;
  support: { s1: number; s2: number };
  resistance: { r1: number; r2: number };
  trend: string;
  pattern: string | null;
  indicators: {
    rsi: number;
    rsiStatus: string;
    macd: string;
    volume: string;
    ma20: number;
    ma50: number;
  };
  entry: number;
  targets: { t1: number; t2: number };
  stopLoss: number;
  riskReward: string;
  timeframe: string;
  confidence: number;
  catalysts: string;
  risks: string;
}

interface WeeklyPicksPayload {
  generatedAt: string;
  expiresAt: string;
  aiProvider: string;
  aiModel: string;
  marketCondition: string;
  picks: PickPayload[];
  top3Summary: string;
  allocationAdvice: string;
}

interface PickWithPerformance {
  id: string;
  rank: number;
  // Per-pick AI source (added for daily multi-provider mode)
  aiProvider: string;
  aiModel: string;
  symbol: string;
  company: string;
  sector: string;
  currentPrice: Prisma.Decimal;
  status: string;
  supportS1: Prisma.Decimal;
  supportS2: Prisma.Decimal;
  resistanceR1: Prisma.Decimal;
  resistanceR2: Prisma.Decimal;
  trend: string;
  pattern: string | null;
  rsi: Prisma.Decimal;
  rsiStatus: string;
  macd: string;
  volume: string;
  ma20: Prisma.Decimal;
  ma50: Prisma.Decimal;
  entry: Prisma.Decimal;
  targetT1: Prisma.Decimal;
  targetT2: Prisma.Decimal;
  stopLoss: Prisma.Decimal;
  riskReward: string;
  timeframe: string;
  confidence: number;
  catalysts: string;
  risks: string;
  performance: {
    status: string;
    isClosed: boolean;
    entryHit: boolean;
    entryHitAt: Date | null;
    t1Hit: boolean;
    t1HitAt: Date | null;
    t2Hit: boolean;
    t2HitAt: Date | null;
    stopHit: boolean;
    stopHitAt: Date | null;
    latestPrice: Prisma.Decimal | null;
    latestPriceAt: Date | null;
    peakPrice: Prisma.Decimal | null;
    troughPrice: Prisma.Decimal | null;
    returnPct: Prisma.Decimal | null;
    daysToT1: number | null;
    daysToT2: number | null;
    daysToStop: number | null;
    evaluationCount: number;
    lastEvaluatedAt: Date;
  } | null;
}

/**
 * Get the Sunday of the EGX trading week containing `now`, expressed as UTC midnight
 * on that Cairo calendar date. Used by legacy weekly-snapshot lookups.
 */
function getSundayOfWeekCairo(now: Date = new Date()): Date {
  const cairoOffsetMs = 2 * 60 * 60 * 1000;
  const cairoNow = new Date(now.getTime() + cairoOffsetMs);
  const dayOfWeek = cairoNow.getUTCDay(); // Sunday = 0
  const sundayCairo = new Date(cairoNow);
  sundayCairo.setUTCDate(cairoNow.getUTCDate() - dayOfWeek);
  sundayCairo.setUTCHours(0, 0, 0, 0);
  return sundayCairo;
}

/**
 * Get today's Cairo calendar date as UTC midnight (matches @db.Date storage),
 * suitable for the daily snapshot key.
 */
function getCairoCalendarDate(now: Date = new Date()): Date {
  const cairoOffsetMs = 2 * 60 * 60 * 1000;
  const cairoNow = new Date(now.getTime() + cairoOffsetMs);
  const todayCairo = new Date(cairoNow);
  todayCairo.setUTCHours(0, 0, 0, 0);
  return todayCairo;
}

@Injectable()
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Capture ────────────────────────────────────────────────────────────

  async captureSnapshot(snapshotDate?: Date): Promise<{
    snapshotId: string;
    pickCount: number;
    aiProvider: string;
    aiModel: string;
    alreadyExisted: boolean;
  }> {
    // Daily mode: capture under today's Cairo calendar date with kind='daily'.
    const targetDate = snapshotDate ?? getCairoCalendarDate();
    const kind = 'daily';

    const existing = await this.prisma.recommendationSnapshot.findUnique({
      where: { snapshotDate_kind: { snapshotDate: targetDate, kind } },
      include: { picks: true },
    });
    if (existing) {
      return {
        snapshotId: existing.id,
        pickCount: existing.picks.length,
        aiProvider: existing.aiProvider,
        aiModel: existing.aiModel,
        alreadyExisted: true,
      };
    }

    // Look back 36h since daily generation runs at 08:00 Cairo
    const lookback = new Date(targetDate.getTime() - 36 * 60 * 60 * 1000);
    const [log, logAr] = await Promise.all([
      this.prisma.weeklyPicksLog.findFirst({
        where: { lang: 'en', generatedAt: { gte: lookback } },
        orderBy: { generatedAt: 'desc' },
      }),
      this.prisma.weeklyPicksLog.findFirst({
        where: { lang: 'ar', generatedAt: { gte: lookback } },
        orderBy: { generatedAt: 'desc' },
      }),
    ]);
    if (!log) {
      throw new NotFoundException(
        'No fresh weekly picks found in log for today — trigger /api/stocks/weekly-picks first',
      );
    }

    const payload = log.payload as unknown as WeeklyPicksPayload;
    const picks = Array.isArray(payload.picks) ? payload.picks : [];
    if (picks.length === 0) {
      throw new NotFoundException('Weekly picks log entry has no picks');
    }

    // Single atomic nested write — avoids the per-row transaction overhead that
    // triggered Prisma's default 5s transaction timeout on slower connections.
    // Each pick now persists its source aiProvider/aiModel (daily mode bundles
    // picks from multiple providers within one snapshot).
    const created = await this.prisma.recommendationSnapshot.create({
      data: {
        snapshotDate: targetDate,
        kind,
        sourceLogId: log.id,
        generatedAt: log.generatedAt,
        expiresAt: log.expiresAt,
        aiProvider: log.aiProvider,
        aiModel: log.aiModel,
        marketCondition: log.marketCondition,
        top3Summary: payload.top3Summary ?? '',
        allocationAdvice: payload.allocationAdvice ?? '',
        payloadAr: (logAr?.payload ?? Prisma.JsonNull) as
          | Prisma.InputJsonValue
          | typeof Prisma.JsonNull,
        picks: {
          create: picks.map((p) => ({
            rank: p.rank,
            // Per-pick AI source: stamp from the pick if present (daily mode), else
            // fall back to the snapshot-level provider (legacy weekly payloads).
            aiProvider:
              (p as { aiProvider?: string }).aiProvider ?? log.aiProvider,
            aiModel: (p as { aiModel?: string }).aiModel ?? log.aiModel,
            symbol: String(p.symbol).toUpperCase(),
            company: p.company ?? '',
            sector: p.sector ?? '',
            currentPrice: new Prisma.Decimal(p.currentPrice ?? 0),
            status: p.status ?? '',
            supportS1: new Prisma.Decimal(p.support?.s1 ?? 0),
            supportS2: new Prisma.Decimal(p.support?.s2 ?? 0),
            resistanceR1: new Prisma.Decimal(p.resistance?.r1 ?? 0),
            resistanceR2: new Prisma.Decimal(p.resistance?.r2 ?? 0),
            trend: p.trend ?? '',
            pattern: p.pattern ?? null,
            rsi: new Prisma.Decimal(p.indicators?.rsi ?? 0),
            rsiStatus: p.indicators?.rsiStatus ?? '',
            macd: p.indicators?.macd ?? '',
            volume: p.indicators?.volume ?? '',
            ma20: new Prisma.Decimal(p.indicators?.ma20 ?? 0),
            ma50: new Prisma.Decimal(p.indicators?.ma50 ?? 0),
            entry: new Prisma.Decimal(p.entry ?? 0),
            targetT1: new Prisma.Decimal(p.targets?.t1 ?? 0),
            targetT2: new Prisma.Decimal(p.targets?.t2 ?? 0),
            stopLoss: new Prisma.Decimal(p.stopLoss ?? 0),
            riskReward: p.riskReward ?? '',
            timeframe: p.timeframe ?? '',
            confidence: Math.round(p.confidence ?? 0),
            catalysts: p.catalysts ?? '',
            risks: p.risks ?? '',
            performance: {
              create: {
                status: STATUS.PENDING,
                isClosed: false,
                evaluationCount: 0,
              },
            },
          })),
        },
      },
    });

    this.logger.log(
      `tracker: captured ${kind} snapshot for ${targetDate.toISOString().slice(0, 10)} (${log.aiProvider}/${log.aiModel}, ${picks.length} picks)`,
    );

    return {
      snapshotId: created.id,
      pickCount: picks.length,
      aiProvider: log.aiProvider,
      aiModel: log.aiModel,
      alreadyExisted: false,
    };
  }

  // ─── Evaluate ───────────────────────────────────────────────────────────

  async evaluateAllActive(): Promise<{ evaluated: number; closed: number }> {
    const activePicks = await this.prisma.trackedPick.findMany({
      where: { performance: { isClosed: false } },
      include: {
        performance: true,
        snapshot: { select: { generatedAt: true, expiresAt: true } },
      },
    });

    if (activePicks.length === 0) {
      return { evaluated: 0, closed: 0 };
    }

    // Group by symbol so we make at most one DB call per symbol.
    const bySymbol = new Map<string, typeof activePicks>();
    for (const p of activePicks) {
      const arr = bySymbol.get(p.symbol) ?? [];
      arr.push(p);
      bySymbol.set(p.symbol, arr);
    }

    let evaluated = 0;
    let closed = 0;
    const now = new Date();

    for (const [symbol, picks] of bySymbol) {
      const earliestSince = picks.reduce(
        (acc, p) =>
          p.snapshot.generatedAt < acc ? p.snapshot.generatedAt : acc,
        picks[0].snapshot.generatedAt,
      );

      const history = await this.prisma.stockPriceHistory.findMany({
        where: { symbol, timestamp: { gte: earliestSince } },
        orderBy: { timestamp: 'asc' },
        select: { price: true, timestamp: true },
      });

      for (const pick of picks) {
        const result = this.computePerformance(
          pick,
          history.filter((h) => h.timestamp >= pick.snapshot.generatedAt),
          now,
        );

        await this.prisma.pickPerformance.update({
          where: { pickId: pick.id },
          data: {
            status: result.status,
            isClosed: result.isClosed,
            entryHit: result.entryHit,
            entryHitAt: result.entryHitAt,
            t1Hit: result.t1Hit,
            t1HitAt: result.t1HitAt,
            t2Hit: result.t2Hit,
            t2HitAt: result.t2HitAt,
            stopHit: result.stopHit,
            stopHitAt: result.stopHitAt,
            latestPrice: result.latestPrice,
            latestPriceAt: result.latestPriceAt,
            peakPrice: result.peakPrice,
            troughPrice: result.troughPrice,
            returnPct: result.returnPct,
            daysToT1: result.daysToT1,
            daysToT2: result.daysToT2,
            daysToStop: result.daysToStop,
            evaluationCount: { increment: 1 },
          },
        });

        evaluated++;
        if (result.isClosed) closed++;
      }
    }

    this.logger.log(
      `tracker: evaluated ${evaluated} active picks, closed ${closed}`,
    );
    return { evaluated, closed };
  }

  private computePerformance(
    pick: {
      entry: Prisma.Decimal;
      targetT1: Prisma.Decimal;
      targetT2: Prisma.Decimal;
      stopLoss: Prisma.Decimal;
      snapshot: { generatedAt: Date; expiresAt: Date };
    },
    history: Array<{ price: Prisma.Decimal; timestamp: Date }>,
    now: Date,
  ): {
    status: StatusValue;
    isClosed: boolean;
    entryHit: boolean;
    entryHitAt: Date | null;
    t1Hit: boolean;
    t1HitAt: Date | null;
    t2Hit: boolean;
    t2HitAt: Date | null;
    stopHit: boolean;
    stopHitAt: Date | null;
    latestPrice: Prisma.Decimal | null;
    latestPriceAt: Date | null;
    peakPrice: Prisma.Decimal | null;
    troughPrice: Prisma.Decimal | null;
    returnPct: Prisma.Decimal | null;
    daysToT1: number | null;
    daysToT2: number | null;
    daysToStop: number | null;
  } {
    const entry = Number(pick.entry);
    const t1 = Number(pick.targetT1);
    const t2 = Number(pick.targetT2);
    const stop = Number(pick.stopLoss);

    let entryHit = false;
    let entryHitAt: Date | null = null;
    let t1Hit = false;
    let t1HitAt: Date | null = null;
    let t2Hit = false;
    let t2HitAt: Date | null = null;
    let stopHit = false;
    let stopHitAt: Date | null = null;

    let peak: number | null = null;
    let trough: number | null = null;
    let latest: number | null = null;
    let latestAt: Date | null = null;

    for (const bar of history) {
      const close = Number(bar.price);
      latest = close;
      latestAt = bar.timestamp;
      peak = peak === null ? close : Math.max(peak, close);
      trough = trough === null ? close : Math.min(trough, close);

      if (!entryHit && close <= entry) {
        entryHit = true;
        entryHitAt = bar.timestamp;
        continue;
      }

      if (entryHit) {
        if (!t1Hit && close >= t1) {
          t1Hit = true;
          t1HitAt = bar.timestamp;
        }
        if (!t2Hit && close >= t2) {
          t2Hit = true;
          t2HitAt = bar.timestamp;
        }
        if (!stopHit && close <= stop) {
          stopHit = true;
          stopHitAt = bar.timestamp;
        }
      }
    }

    let status: StatusValue;
    if (stopHit) status = STATUS.STOPPED;
    else if (t2Hit) status = STATUS.T2_HIT;
    else if (t1Hit) status = STATUS.T1_HIT;
    else if (entryHit) status = STATUS.ENTERED;
    else status = STATUS.PENDING;

    if (
      status !== STATUS.T2_HIT &&
      status !== STATUS.STOPPED &&
      pick.snapshot.expiresAt < now
    ) {
      status = STATUS.EXPIRED;
    }

    const isClosed =
      status === STATUS.T2_HIT ||
      status === STATUS.STOPPED ||
      status === STATUS.EXPIRED;

    const daysBetween = (a: Date, b: Date): number =>
      Math.max(
        0,
        Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000)),
      );

    return {
      status,
      isClosed,
      entryHit,
      entryHitAt,
      t1Hit,
      t1HitAt,
      t2Hit,
      t2HitAt,
      stopHit,
      stopHitAt,
      latestPrice: latest !== null ? new Prisma.Decimal(latest) : null,
      latestPriceAt: latestAt,
      peakPrice: peak !== null ? new Prisma.Decimal(peak) : null,
      troughPrice: trough !== null ? new Prisma.Decimal(trough) : null,
      returnPct:
        latest !== null && entry > 0
          ? new Prisma.Decimal(((latest - entry) / entry) * 100)
          : null,
      daysToT1: t1HitAt && entryHitAt ? daysBetween(t1HitAt, entryHitAt) : null,
      daysToT2: t2HitAt && entryHitAt ? daysBetween(t2HitAt, entryHitAt) : null,
      daysToStop:
        stopHitAt && entryHitAt ? daysBetween(stopHitAt, entryHitAt) : null,
    };
  }

  // ─── Reads ──────────────────────────────────────────────────────────────

  async getSnapshots(aiProvider?: string, kind?: 'daily' | 'weekly') {
    const where: Prisma.RecommendationSnapshotWhereInput = {};
    if (aiProvider) where.aiProvider = aiProvider;
    if (kind) where.kind = kind;
    const snapshots = await this.prisma.recommendationSnapshot.findMany({
      where,
      orderBy: { snapshotDate: 'desc' },
      include: {
        picks: { include: { performance: true } },
      },
    });

    return snapshots.map((s) => {
      let t1Hits = 0;
      let t2Hits = 0;
      let stops = 0;
      let pending = 0;
      for (const p of s.picks) {
        const st = p.performance?.status ?? 'PENDING';
        if (st === 'T2_HIT') t2Hits++;
        else if (st === 'T1_HIT') t1Hits++;
        else if (st === 'STOPPED') stops++;
        else pending++;
      }
      return {
        id: s.id,
        // Keep `weekStartDate` for back-compat with existing frontend code; it
        // now holds the snapshot's calendar date regardless of kind.
        weekStartDate: s.snapshotDate.toISOString().slice(0, 10),
        snapshotDate: s.snapshotDate.toISOString().slice(0, 10),
        kind: s.kind,
        generatedAt: s.generatedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        aiProvider: s.aiProvider,
        aiModel: s.aiModel,
        marketCondition: s.marketCondition,
        pickCount: s.picks.length,
        summaryStats: { t1Hits, t2Hits, stops, pending },
      };
    });
  }

  async getSnapshotByDate(date: string, lang?: string) {
    // Daily mode: find the snapshot for the exact target date with kind='daily'.
    // Falls back to the most recent daily snapshot on or before the target date,
    // and finally to weekly snapshots if no daily exists.
    const target = new Date(date + 'T00:00:00.000Z');
    if (Number.isNaN(target.getTime())) {
      throw new NotFoundException('Invalid date');
    }

    let snapshot = await this.prisma.recommendationSnapshot.findUnique({
      where: { snapshotDate_kind: { snapshotDate: target, kind: 'daily' } },
      include: {
        picks: { orderBy: { rank: 'asc' }, include: { performance: true } },
      },
    });

    if (!snapshot) {
      // Fall back to most recent snapshot (daily or weekly) on or before target
      snapshot = await this.prisma.recommendationSnapshot.findFirst({
        where: { snapshotDate: { lte: target } },
        orderBy: [{ snapshotDate: 'desc' }, { kind: 'asc' }],
        include: {
          picks: { orderBy: { rank: 'asc' }, include: { performance: true } },
        },
      });
    }

    if (!snapshot) {
      throw new NotFoundException(`No snapshot found for date ${date}`);
    }

    // For weekly snapshots, ensure the requested date falls within the 7-day window
    if (snapshot.kind === 'weekly') {
      const weekEnd = new Date(
        snapshot.snapshotDate.getTime() + 7 * 24 * 60 * 60 * 1000,
      );
      if (target >= weekEnd) {
        throw new NotFoundException(`No snapshot covers date ${date}`);
      }
    }

    const payloadAr =
      lang === 'ar' ? this.parsePayloadAr(snapshot.payloadAr) : null;
    return this.serializeSnapshot(snapshot, payloadAr);
  }

  async getPickDetail(pickId: string, lang?: string) {
    const pick = await this.prisma.trackedPick.findUnique({
      where: { id: pickId },
      include: {
        performance: true,
        snapshot: {
          select: {
            generatedAt: true,
            expiresAt: true,
            aiProvider: true,
            aiModel: true,
            payloadAr: true,
          },
        },
      },
    });
    if (!pick) throw new NotFoundException('Pick not found');

    const history = await this.prisma.stockPriceHistory.findMany({
      where: {
        symbol: pick.symbol,
        timestamp: { gte: pick.snapshot.generatedAt },
      },
      orderBy: { timestamp: 'asc' },
      select: { price: true, timestamp: true },
    });

    const payloadAr =
      lang === 'ar' ? this.parsePayloadAr(pick.snapshot.payloadAr) : null;
    return {
      pick: this.serializePick(pick, payloadAr),
      snapshot: {
        generatedAt: pick.snapshot.generatedAt.toISOString(),
        expiresAt: pick.snapshot.expiresAt.toISOString(),
        aiProvider: pick.snapshot.aiProvider,
        aiModel: pick.snapshot.aiModel,
      },
      priceHistory: history.map((h) => ({
        timestamp: h.timestamp.toISOString(),
        price: Number(h.price),
      })),
    };
  }

  /**
   * Find any snapshot missing payloadAr and try to populate it from a
   * matching weekly_picks_log row with lang='ar' from that week.
   * Returns count of snapshots updated. Idempotent.
   */
  async backfillArPayloads(): Promise<{ updated: number; checked: number }> {
    const snapshots = await this.prisma.recommendationSnapshot.findMany({
      where: { payloadAr: { equals: Prisma.AnyNull } },
      select: { id: true, snapshotDate: true, kind: true },
    });
    let updated = 0;
    for (const s of snapshots) {
      // Daily: search within ±36h of snapshotDate. Weekly: keep the original 7-day window.
      const isWeekly = s.kind === 'weekly';
      const lookbackMs = isWeekly
        ? 7 * 24 * 60 * 60 * 1000
        : 36 * 60 * 60 * 1000;
      const lookforwardMs = isWeekly
        ? 7 * 24 * 60 * 60 * 1000
        : 36 * 60 * 60 * 1000;
      const arLog = await this.prisma.weeklyPicksLog.findFirst({
        where: {
          lang: 'ar',
          generatedAt: {
            gte: new Date(s.snapshotDate.getTime() - lookbackMs),
            lt: new Date(s.snapshotDate.getTime() + lookforwardMs),
          },
        },
        orderBy: { generatedAt: 'desc' },
      });
      if (!arLog) continue;
      await this.prisma.recommendationSnapshot.update({
        where: { id: s.id },
        data: { payloadAr: arLog.payload as unknown as Prisma.InputJsonValue },
      });
      updated++;
    }
    if (updated > 0) {
      this.logger.log(
        `tracker: backfilled AR payload on ${updated}/${snapshots.length} snapshots`,
      );
    }
    return { updated, checked: snapshots.length };
  }

  private parsePayloadAr(
    raw: Prisma.JsonValue | null,
  ): WeeklyPicksPayload | null {
    if (!raw) return null;
    try {
      return raw as unknown as WeeklyPicksPayload;
    } catch {
      return null;
    }
  }

  /** Look up a single AR pick by symbol + rank from a parsed AR payload. */
  private findArPick(
    payloadAr: WeeklyPicksPayload | null,
    symbol: string,
    rank: number,
  ): PickPayload | null {
    if (!payloadAr?.picks) return null;
    const sym = symbol.toUpperCase();
    return (
      payloadAr.picks.find(
        (p) => String(p.symbol).toUpperCase() === sym && p.rank === rank,
      ) ??
      payloadAr.picks.find((p) => String(p.symbol).toUpperCase() === sym) ??
      null
    );
  }

  async getStats() {
    const closedPicks = await this.prisma.pickPerformance.findMany({
      where: { isClosed: true },
      include: {
        pick: {
          select: {
            snapshot: { select: { aiProvider: true, aiModel: true } },
          },
        },
      },
    });

    const allPicks = await this.prisma.pickPerformance.findMany({
      include: {
        pick: {
          select: {
            snapshot: { select: { aiProvider: true, aiModel: true } },
          },
        },
      },
    });

    const summarize = (
      group: typeof allPicks,
    ): {
      sampleSize: number;
      closedSize: number;
      t1Rate: number;
      t2Rate: number;
      stopRate: number;
      pendingRate: number;
      avgReturn: number | null;
    } => {
      const sampleSize = group.length;
      const closed = group.filter((p) => p.isClosed);
      const closedSize = closed.length;
      const t1 = group.filter((p) => p.t1Hit).length;
      const t2 = group.filter((p) => p.t2Hit).length;
      const stop = group.filter((p) => p.stopHit).length;
      const pending = group.filter(
        (p) => p.status === 'PENDING' || p.status === 'ENTERED',
      ).length;
      const returns = group
        .map((p) => (p.returnPct !== null ? Number(p.returnPct) : null))
        .filter((v): v is number => v !== null);
      const avgReturn =
        returns.length > 0
          ? returns.reduce((s, v) => s + v, 0) / returns.length
          : null;
      return {
        sampleSize,
        closedSize,
        t1Rate: sampleSize ? t1 / sampleSize : 0,
        t2Rate: sampleSize ? t2 / sampleSize : 0,
        stopRate: sampleSize ? stop / sampleSize : 0,
        pendingRate: sampleSize ? pending / sampleSize : 0,
        avgReturn,
      };
    };

    const byModel: Record<
      string,
      ReturnType<typeof summarize> & { aiModel: string }
    > = {};
    for (const p of allPicks) {
      const provider = p.pick.snapshot.aiProvider;
      const model = p.pick.snapshot.aiModel;
      if (!byModel[provider]) {
        const subset = allPicks.filter(
          (x) => x.pick.snapshot.aiProvider === provider,
        );
        byModel[provider] = { ...summarize(subset), aiModel: model };
      }
    }

    return {
      overall: summarize(allPicks),
      closedSize: closedPicks.length,
      byModel,
    };
  }

  // ─── Serializers ────────────────────────────────────────────────────────

  private serializeSnapshot(
    snapshot: {
      id: string;
      snapshotDate: Date;
      kind: string;
      generatedAt: Date;
      expiresAt: Date;
      aiProvider: string;
      aiModel: string;
      marketCondition: string;
      top3Summary: string;
      allocationAdvice: string;
      picks: PickWithPerformance[];
    },
    payloadAr: WeeklyPicksPayload | null = null,
  ) {
    const dateStr = snapshot.snapshotDate.toISOString().slice(0, 10);
    return {
      id: snapshot.id,
      // Back-compat: expose under both names so existing frontend code keeps working
      weekStartDate: dateStr,
      snapshotDate: dateStr,
      kind: snapshot.kind,
      generatedAt: snapshot.generatedAt.toISOString(),
      expiresAt: snapshot.expiresAt.toISOString(),
      aiProvider: snapshot.aiProvider,
      aiModel: snapshot.aiModel,
      marketCondition: snapshot.marketCondition,
      top3Summary: payloadAr?.top3Summary || snapshot.top3Summary,
      allocationAdvice:
        payloadAr?.allocationAdvice || snapshot.allocationAdvice,
      picks: snapshot.picks.map((p) => this.serializePick(p, payloadAr)),
    };
  }

  private serializePick(
    p: PickWithPerformance,
    payloadAr: WeeklyPicksPayload | null = null,
  ) {
    const ar = this.findArPick(payloadAr, p.symbol, p.rank);
    return {
      id: p.id,
      rank: p.rank,
      symbol: p.symbol,
      company: ar?.company || p.company,
      sector: ar?.sector || p.sector,
      currentPrice: Number(p.currentPrice),
      status: ar?.status || p.status,
      // Per-pick AI source (daily mode bundles picks from multiple providers)
      aiProvider: p.aiProvider,
      aiModel: p.aiModel,
      support: { s1: Number(p.supportS1), s2: Number(p.supportS2) },
      resistance: { r1: Number(p.resistanceR1), r2: Number(p.resistanceR2) },
      trend: ar?.trend || p.trend,
      pattern: ar?.pattern ?? p.pattern,
      indicators: {
        rsi: Number(p.rsi),
        rsiStatus: ar?.indicators?.rsiStatus || p.rsiStatus,
        macd: ar?.indicators?.macd || p.macd,
        volume: ar?.indicators?.volume || p.volume,
        ma20: Number(p.ma20),
        ma50: Number(p.ma50),
      },
      entry: Number(p.entry),
      targets: { t1: Number(p.targetT1), t2: Number(p.targetT2) },
      stopLoss: Number(p.stopLoss),
      riskReward: p.riskReward,
      timeframe: ar?.timeframe || p.timeframe,
      confidence: p.confidence,
      catalysts: ar?.catalysts || p.catalysts,
      risks: ar?.risks || p.risks,
      performance: p.performance
        ? {
            status: p.performance.status,
            isClosed: p.performance.isClosed,
            entryHit: p.performance.entryHit,
            entryHitAt: p.performance.entryHitAt?.toISOString() ?? null,
            t1Hit: p.performance.t1Hit,
            t1HitAt: p.performance.t1HitAt?.toISOString() ?? null,
            t2Hit: p.performance.t2Hit,
            t2HitAt: p.performance.t2HitAt?.toISOString() ?? null,
            stopHit: p.performance.stopHit,
            stopHitAt: p.performance.stopHitAt?.toISOString() ?? null,
            latestPrice:
              p.performance.latestPrice !== null
                ? Number(p.performance.latestPrice)
                : null,
            latestPriceAt: p.performance.latestPriceAt?.toISOString() ?? null,
            peakPrice:
              p.performance.peakPrice !== null
                ? Number(p.performance.peakPrice)
                : null,
            troughPrice:
              p.performance.troughPrice !== null
                ? Number(p.performance.troughPrice)
                : null,
            returnPct:
              p.performance.returnPct !== null
                ? Number(p.performance.returnPct)
                : null,
            daysToT1: p.performance.daysToT1,
            daysToT2: p.performance.daysToT2,
            daysToStop: p.performance.daysToStop,
            evaluationCount: p.performance.evaluationCount,
            lastEvaluatedAt: p.performance.lastEvaluatedAt.toISOString(),
          }
        : null,
    };
  }
}
