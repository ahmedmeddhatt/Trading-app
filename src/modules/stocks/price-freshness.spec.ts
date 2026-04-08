/**
 * Unit tests for price freshness classification logic.
 * Tests the math used in StocksService.getDashboard pricesMeta computation.
 * No external dependencies — pure function testing.
 */

const FRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

interface LivePrice {
  price: number;
  changePercent: number;
  timestamp: string;
}

/** Mirrors the freshness classification logic from StocksService.getDashboard */
function classifyPrices(
  rawPrices: Record<string, LivePrice>,
  totalDbSymbols: number,
  nowMs: number,
) {
  let symbolsWithFreshPrice = 0;
  let symbolsWithStalePrice = 0;
  let oldestUpdate: Date | null = null;
  let newestUpdate: Date | null = null;

  for (const lp of Object.values(rawPrices)) {
    if (!lp.timestamp) continue;
    const ts = new Date(lp.timestamp);
    const age = nowMs - ts.getTime();
    if (age <= FRESH_THRESHOLD_MS) symbolsWithFreshPrice++;
    else symbolsWithStalePrice++;
    if (!oldestUpdate || ts < oldestUpdate) oldestUpdate = ts;
    if (!newestUpdate || ts > newestUpdate) newestUpdate = ts;
  }

  return {
    totalSymbols: totalDbSymbols,
    symbolsWithFreshPrice,
    symbolsWithStalePrice,
    symbolsWithNoPrice: Math.max(
      0,
      totalDbSymbols - symbolsWithFreshPrice - symbolsWithStalePrice,
    ),
    oldestUpdate: oldestUpdate?.toISOString() ?? null,
    newestUpdate: newestUpdate?.toISOString() ?? null,
  };
}

/** Build a LivePrice with a timestamp exactly `ageMs` milliseconds before `nowMs` */
function lp(ageMs: number, nowMs: number, price = 50): LivePrice {
  return {
    price,
    changePercent: 1,
    timestamp: new Date(nowMs - ageMs).toISOString(),
  };
}

describe('Price freshness classification', () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
  });

  it('symbol updated 3 min ago → fresh', () => {
    const meta = classifyPrices({ COMI: lp(3 * 60 * 1000, now) }, 1, now);
    expect(meta.symbolsWithFreshPrice).toBe(1);
    expect(meta.symbolsWithStalePrice).toBe(0);
  });

  it('symbol updated 10 min ago → stale', () => {
    const meta = classifyPrices({ COMI: lp(10 * 60 * 1000, now) }, 1, now);
    expect(meta.symbolsWithFreshPrice).toBe(0);
    expect(meta.symbolsWithStalePrice).toBe(1);
  });

  it('symbol updated 120 min ago → stale (dead)', () => {
    const meta = classifyPrices({ COMI: lp(120 * 60 * 1000, now) }, 1, now);
    expect(meta.symbolsWithFreshPrice).toBe(0);
    expect(meta.symbolsWithStalePrice).toBe(1);
  });

  it('symbol with no Redis entry → counted as missing (symbolsWithNoPrice)', () => {
    const meta = classifyPrices({}, 3, now);
    expect(meta.symbolsWithNoPrice).toBe(3);
    expect(meta.symbolsWithFreshPrice).toBe(0);
    expect(meta.symbolsWithStalePrice).toBe(0);
  });

  it('newestUpdate = max of all lastUpdate values', () => {
    const prices = {
      COMI: lp(2 * 60 * 1000, now), // 2 min ago → newer
      HRHO: lp(8 * 60 * 1000, now), // 8 min ago → older
    };
    const meta = classifyPrices(prices, 2, now);
    const newest = new Date(meta.newestUpdate!).getTime();
    const oldest = new Date(meta.oldestUpdate!).getTime();
    expect(newest).toBeGreaterThan(oldest);
    expect(now - newest).toBeCloseTo(2 * 60 * 1000, -3);
    expect(now - oldest).toBeCloseTo(8 * 60 * 1000, -3);
  });

  it('oldestUpdate = min of all lastUpdate values', () => {
    const prices = {
      COMI: lp(1 * 60 * 1000, now),
      HRHO: lp(20 * 60 * 1000, now),
      EFIH: lp(5 * 60 * 1000, now),
    };
    const meta = classifyPrices(prices, 3, now);
    const oldestAgeMs = now - new Date(meta.oldestUpdate!).getTime();
    expect(oldestAgeMs).toBe(20 * 60 * 1000);
  });

  it('exactly at 5min boundary → counts as fresh', () => {
    const meta = classifyPrices({ COMI: lp(FRESH_THRESHOLD_MS, now) }, 1, now);
    expect(meta.symbolsWithFreshPrice).toBe(1);
  });

  it('1ms over boundary → counts as stale', () => {
    const meta = classifyPrices(
      { COMI: lp(FRESH_THRESHOLD_MS + 1, now) },
      1,
      now,
    );
    expect(meta.symbolsWithStalePrice).toBe(1);
  });

  it('symbolsWithNoPrice = max(0, total - fresh - stale)', () => {
    const prices = { COMI: lp(1 * 60 * 1000, now) };
    const meta = classifyPrices(prices, 5, now);
    expect(meta.symbolsWithNoPrice).toBe(4);
  });

  it('returns null for oldestUpdate and newestUpdate when no prices in Redis', () => {
    const meta = classifyPrices({}, 10, now);
    expect(meta.oldestUpdate).toBeNull();
    expect(meta.newestUpdate).toBeNull();
  });
});
