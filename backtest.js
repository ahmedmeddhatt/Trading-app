/* eslint-disable */
/**
 * Backtest harness for the Recommendations Tracker.
 *
 * Picks Sundays at a configurable interval starting from the earliest date
 * we have stock_price_history for, calls the running backend's
 * /stocks/weekly-picks endpoint with ?asOfDate so the AI sees only that
 * day's price snapshot, materializes RecommendationSnapshot rows directly
 * via Prisma (mimicking TrackerService.captureSnapshot), and finally runs
 * the same hit-detection logic against subsequent real prices to produce
 * PickPerformance rows.
 *
 * Run from the Trading-app project root with: node backtest.js
 */
const { PrismaClient, Prisma } = require('@prisma/client');

const BACKEND = process.env.BACKEND_URL || 'http://localhost:4000';
const INTERVAL_WEEKS = 4;
const START_FROM = '2025-04-13'; // first Sunday on/after the earliest archive day (2025-04-09)
const LANG = 'en';
const MAX_RETRIES = 2;

const prisma = new PrismaClient();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** UTC midnight on the Sunday on or before `d`. */
function sundayOf(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  x.setUTCDate(x.getUTCDate() - x.getUTCDay()); // sunday=0
  return x;
}

async function listSundays() {
  const start = sundayOf(new Date(START_FROM + 'T00:00:00Z'));
  // End: Sunday before today, so we have at least a week of forward prices
  const cutoff = sundayOf(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  const sundays = [];
  for (
    let d = new Date(start);
    d <= cutoff;
    d.setUTCDate(d.getUTCDate() + INTERVAL_WEEKS * 7)
  ) {
    sundays.push(new Date(d));
  }
  return sundays;
}

async function generatePicksForDate(asOf) {
  const expectedDate = isoDate(asOf);
  for (let attempt = 0; attempt < MAX_RETRIES + 1; attempt++) {
    try {
      const res = await fetch(
        `${BACKEND}/stocks/weekly-picks?lang=${LANG}&refresh=true&asOfDate=${expectedDate}`,
        { headers: { 'Content-Type': 'application/json' } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const payload = body.data ?? body;
      const got = (payload?.generatedAt ?? '').slice(0, 10);
      if (got !== expectedDate) {
        throw new Error(`generatedAt mismatch (got ${got}, expected ${expectedDate}) — likely served from stale cache`);
      }
      return payload;
    } catch (err) {
      console.warn(`  [retry ${attempt + 1}] generate failed for ${expectedDate}: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      await sleep(3000);
    }
  }
}

async function captureSnapshotFromLog(weekStart) {
  // Idempotent — return existing if already captured.
  const existing = await prisma.recommendationSnapshot.findUnique({
    where: { weekStartDate: weekStart },
    include: { picks: true },
  });
  if (existing) return { snapshotId: existing.id, pickCount: existing.picks.length, alreadyExisted: true };

  // Find the most recent EN log row generated within ±7d of the target Sunday.
  const sevenDaysBefore = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sevenDaysAfter = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const log = await prisma.weeklyPicksLog.findFirst({
    where: {
      lang: 'en',
      generatedAt: { gte: sevenDaysBefore, lte: sevenDaysAfter },
    },
    orderBy: { generatedAt: 'desc' },
  });
  if (!log) throw new Error(`no log row for week ${isoDate(weekStart)}`);

  const payload = log.payload;
  const picks = Array.isArray(payload.picks) ? payload.picks : [];
  if (picks.length === 0) throw new Error('log has no picks');

  const created = await prisma.recommendationSnapshot.create({
    data: {
      weekStartDate: weekStart,
      sourceLogId: log.id,
      generatedAt: log.generatedAt,
      expiresAt: log.expiresAt,
      aiProvider: log.aiProvider,
      aiModel: log.aiModel,
      marketCondition: log.marketCondition,
      top3Summary: payload.top3Summary ?? '',
      allocationAdvice: payload.allocationAdvice ?? '',
      picks: {
        create: picks.map((p) => ({
          rank: p.rank,
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
            create: { status: 'PENDING', isClosed: false, evaluationCount: 0 },
          },
        })),
      },
    },
  });

  return { snapshotId: created.id, pickCount: picks.length, alreadyExisted: false };
}

function evaluatePick(pick, history, now) {
  const entry = Number(pick.entry);
  const t1 = Number(pick.targetT1);
  const t2 = Number(pick.targetT2);
  const stop = Number(pick.stopLoss);

  let entryHit = false, entryHitAt = null;
  let t1Hit = false, t1HitAt = null;
  let t2Hit = false, t2HitAt = null;
  let stopHit = false, stopHitAt = null;
  let peak = null, trough = null, latest = null, latestAt = null;

  for (const bar of history) {
    const c = Number(bar.price);
    latest = c; latestAt = bar.timestamp;
    peak = peak === null ? c : Math.max(peak, c);
    trough = trough === null ? c : Math.min(trough, c);

    if (!entryHit && c <= entry) { entryHit = true; entryHitAt = bar.timestamp; continue; }
    if (entryHit) {
      if (!t1Hit && c >= t1) { t1Hit = true; t1HitAt = bar.timestamp; }
      if (!t2Hit && c >= t2) { t2Hit = true; t2HitAt = bar.timestamp; }
      if (!stopHit && c <= stop) { stopHit = true; stopHitAt = bar.timestamp; }
    }
  }

  let status;
  if (stopHit) status = 'STOPPED';
  else if (t2Hit) status = 'T2_HIT';
  else if (t1Hit) status = 'T1_HIT';
  else if (entryHit) status = 'ENTERED';
  else status = 'PENDING';

  if (status !== 'T2_HIT' && status !== 'STOPPED' && pick.snapshot.expiresAt < now) {
    status = 'EXPIRED';
  }
  const isClosed = status === 'T2_HIT' || status === 'STOPPED' || status === 'EXPIRED';

  const days = (a, b) => Math.max(0, Math.round((a.getTime() - b.getTime()) / 86400000));

  return {
    status, isClosed,
    entryHit, entryHitAt, t1Hit, t1HitAt, t2Hit, t2HitAt, stopHit, stopHitAt,
    latestPrice: latest !== null ? new Prisma.Decimal(latest) : null,
    latestPriceAt: latestAt,
    peakPrice: peak !== null ? new Prisma.Decimal(peak) : null,
    troughPrice: trough !== null ? new Prisma.Decimal(trough) : null,
    returnPct: latest !== null && entry > 0 ? new Prisma.Decimal(((latest - entry) / entry) * 100) : null,
    daysToT1: t1HitAt && entryHitAt ? days(t1HitAt, entryHitAt) : null,
    daysToT2: t2HitAt && entryHitAt ? days(t2HitAt, entryHitAt) : null,
    daysToStop: stopHitAt && entryHitAt ? days(stopHitAt, entryHitAt) : null,
  };
}

async function evaluateAll() {
  const picks = await prisma.trackedPick.findMany({
    include: {
      performance: true,
      snapshot: { select: { generatedAt: true, expiresAt: true } },
    },
  });
  if (picks.length === 0) return { evaluated: 0, closed: 0 };

  const bySymbol = new Map();
  for (const p of picks) {
    const arr = bySymbol.get(p.symbol) ?? [];
    arr.push(p);
    bySymbol.set(p.symbol, arr);
  }

  const now = new Date();
  let evaluated = 0, closed = 0;

  for (const [symbol, picksForSym] of bySymbol) {
    const earliest = picksForSym.reduce(
      (acc, p) => (p.snapshot.generatedAt < acc ? p.snapshot.generatedAt : acc),
      picksForSym[0].snapshot.generatedAt,
    );
    const history = await prisma.stockPriceHistory.findMany({
      where: { symbol, timestamp: { gte: earliest } },
      orderBy: { timestamp: 'asc' },
      select: { price: true, timestamp: true },
    });

    for (const pick of picksForSym) {
      const r = evaluatePick(pick, history.filter((h) => h.timestamp >= pick.snapshot.generatedAt), now);
      await prisma.pickPerformance.update({
        where: { pickId: pick.id },
        data: {
          status: r.status,
          isClosed: r.isClosed,
          entryHit: r.entryHit, entryHitAt: r.entryHitAt,
          t1Hit: r.t1Hit, t1HitAt: r.t1HitAt,
          t2Hit: r.t2Hit, t2HitAt: r.t2HitAt,
          stopHit: r.stopHit, stopHitAt: r.stopHitAt,
          latestPrice: r.latestPrice, latestPriceAt: r.latestPriceAt,
          peakPrice: r.peakPrice, troughPrice: r.troughPrice,
          returnPct: r.returnPct,
          daysToT1: r.daysToT1, daysToT2: r.daysToT2, daysToStop: r.daysToStop,
          evaluationCount: { increment: 1 },
        },
      });
      evaluated++;
      if (r.isClosed) closed++;
    }
  }

  return { evaluated, closed };
}

async function main() {
  const sundays = await listSundays();
  console.log(`Backtest plan: ${sundays.length} sampled Sundays (every ${INTERVAL_WEEKS} weeks)`);
  console.log(sundays.map(isoDate).join(', '));

  for (const sun of sundays) {
    const dateStr = isoDate(sun);

    // If snapshot already exists for this week, skip.
    const have = await prisma.recommendationSnapshot.findUnique({
      where: { weekStartDate: sun },
      select: { id: true },
    });
    if (have) {
      console.log(`[${dateStr}] snapshot already exists — skipping AI call`);
      continue;
    }

    // Skip Sundays we don't have price history for at all
    const anyPrice = await prisma.stockPriceHistory.findFirst({
      where: { timestamp: { lte: sun } },
      select: { id: true },
    });
    if (!anyPrice) {
      console.log(`[${dateStr}] no price history at or before this date — skipping`);
      continue;
    }

    console.log(`[${dateStr}] generating AI picks...`);
    try {
      const result = await generatePicksForDate(sun);
      console.log(
        `[${dateStr}] generated by ${result.aiProvider} (${result.aiModel}); picks=${result.picks?.length ?? 0}`,
      );
    } catch (err) {
      console.warn(`[${dateStr}] generation FAILED: ${err.message} — skipping snapshot`);
      continue;
    }

    try {
      const cap = await captureSnapshotFromLog(sun);
      console.log(`[${dateStr}] captured snapshot (picks=${cap.pickCount})`);
    } catch (err) {
      console.warn(`[${dateStr}] capture FAILED: ${err.message}`);
    }

    // Throttle so we don't hammer Groq's free tier
    await sleep(2000);
  }

  console.log('Evaluating all picks against archived prices...');
  const evalResult = await evaluateAll();
  console.log(`Eval done: ${evalResult.evaluated} picks evaluated, ${evalResult.closed} closed`);

  // Print stats
  const stats = await prisma.pickPerformance.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  console.log('Final status distribution:');
  for (const s of stats) console.log(`  ${s.status}: ${s._count._all}`);

  const closed = await prisma.pickPerformance.findMany({ where: { isClosed: true } });
  if (closed.length > 0) {
    const t1 = closed.filter((c) => c.t1Hit).length;
    const t2 = closed.filter((c) => c.t2Hit).length;
    const stop = closed.filter((c) => c.stopHit).length;
    const avgReturn =
      closed.map((c) => (c.returnPct === null ? 0 : Number(c.returnPct))).reduce((s, v) => s + v, 0) /
      closed.length;
    console.log(`Closed picks: ${closed.length}`);
    console.log(`  T1 hit: ${t1} (${((t1 / closed.length) * 100).toFixed(1)}%)`);
    console.log(`  T2 hit: ${t2} (${((t2 / closed.length) * 100).toFixed(1)}%)`);
    console.log(`  Stopped: ${stop} (${((stop / closed.length) * 100).toFixed(1)}%)`);
    console.log(`  Avg return: ${avgReturn.toFixed(2)}%`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
