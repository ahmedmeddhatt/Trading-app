/* eslint-disable */
/**
 * Backfill stock_price_history from Yahoo Finance for every symbol in the
 * `stocks` table. Wipes the existing (mostly bogus) rows and inserts real
 * daily-close prices from Yahoo's chart API.
 *
 * Run from the Trading-app project root: node backfill-history.js
 *
 * Resumable: skips symbols that already have a healthy (>30 distinct closes)
 * stock_price_history dataset, so re-running after a connection drop picks
 * up where it left off without redoing earlier work.
 */
const { PrismaClient, Prisma } = require('@prisma/client');

const FROM_DATE = '2024-01-01';
const TO_DATE_OFFSET_DAYS = 1; // include today
const THROTTLE_MS = 250;       // between Yahoo requests
const BATCH_INSERT_SIZE = 500;
const DB_RETRY_LIMIT = 3;

let prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withDbRetry(fn, ctx) {
  for (let attempt = 0; attempt < DB_RETRY_LIMIT; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err?.code;
      const transient = code === 'P1017' || code === 'P1001' || code === 'P1008';
      if (!transient || attempt === DB_RETRY_LIMIT - 1) throw err;
      console.warn(`  [db-retry ${attempt + 1}] ${ctx}: ${err.message?.slice(0, 80)}`);
      try { await prisma.$disconnect(); } catch {}
      await sleep(2000);
      prisma = new PrismaClient();
    }
  }
}

function yahooSymbol(sym) {
  return sym.startsWith('.') ? `%5E${sym.slice(1)}.CA` : `${sym}.CA`;
}

async function fetchYahoo(symbol, from, to) {
  const yahoo = yahooSymbol(symbol);
  const period1 = Math.floor(from.getTime() / 1000);
  const period2 = Math.floor(to.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahoo}?period1=${period1}&period2=${period2}&interval=1d`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, points: [] };
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!timestamps || !closes) {
    return { ok: false, status: 0, points: [] };
  }
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null || c <= 0) continue;
    points.push({ timestamp: new Date(timestamps[i] * 1000), price: c });
  }
  return { ok: true, status: res.status, points };
}

async function main() {
  const stocks = await prisma.stock.findMany({ select: { symbol: true }, orderBy: { symbol: 'asc' } });
  console.log(`Backfilling ${stocks.length} symbols from Yahoo Finance (${FROM_DATE} → today)`);

  const from = new Date(FROM_DATE + 'T00:00:00Z');
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + TO_DATE_OFFSET_DAYS);

  let okCount = 0;
  let skipCount = 0;
  let totalRowsInserted = 0;
  const skipped = [];

  for (let idx = 0; idx < stocks.length; idx++) {
    const { symbol } = stocks[idx];
    const tag = `[${(idx + 1).toString().padStart(3)}/${stocks.length}] ${symbol.padEnd(8)}`;

    // Skip symbols that already have a healthy dataset (resume support).
    // We require many distinct closes — a stock that legitimately traded for a
    // year should have hundreds of unique daily-close values. Symbols where
    // distinct/rows is tiny are leftover frozen-archive rows we want to wipe.
    try {
      const existing = await withDbRetry(
        () => prisma.$queryRaw`
          SELECT COUNT(DISTINCT price)::int AS distinct_closes, COUNT(*)::int AS rows
          FROM stock_price_history WHERE symbol = ${symbol}
        `,
        `count(${symbol})`,
      );
      const ec = existing?.[0];
      if (ec && ec.rows >= 100 && ec.distinct_closes >= 50) {
        console.log(`${tag} already backfilled (${ec.rows} rows, ${ec.distinct_closes} distinct) — skipping`);
        okCount++;
        continue;
      }
      if (ec && ec.rows > 0) {
        console.log(`${tag} suspect existing data (${ec.rows} rows, ${ec.distinct_closes} distinct) — re-fetching`);
      }
    } catch (err) {
      console.warn(`${tag} pre-check failed: ${err.message} — proceeding anyway`);
    }

    let yahoo;
    try {
      yahoo = await fetchYahoo(symbol, from, to);
    } catch (err) {
      console.warn(`${tag} Yahoo fetch error: ${err.message} — skipping`);
      skipCount++; skipped.push(symbol);
      await sleep(THROTTLE_MS);
      continue;
    }

    if (!yahoo.ok || yahoo.points.length === 0) {
      console.warn(`${tag} no data from Yahoo (status=${yahoo.status}) — wiping existing rows`);
      await withDbRetry(
        () => prisma.stockPriceHistory.deleteMany({ where: { symbol } }),
        `wipe-bad(${symbol})`,
      );
      skipCount++; skipped.push(symbol);
      await sleep(THROTTLE_MS);
      continue;
    }

    // Reject "frozen" Yahoo tickers — stale/delisted symbols where every close
    // is identical (e.g. ORAS.CA returns 71.05 every day for 2+ years).
    const distinctCloses = new Set(yahoo.points.map((p) => p.price.toFixed(4))).size;
    if (distinctCloses < 5) {
      console.warn(`${tag} Yahoo data is frozen (only ${distinctCloses} distinct closes over ${yahoo.points.length} bars) — wiping existing rows`);
      await withDbRetry(
        () => prisma.stockPriceHistory.deleteMany({ where: { symbol } }),
        `wipe-bad(${symbol})`,
      );
      skipCount++; skipped.push(symbol);
      await sleep(THROTTLE_MS);
      continue;
    }

    // Wipe existing rows for this symbol
    await withDbRetry(
      () => prisma.stockPriceHistory.deleteMany({ where: { symbol } }),
      `delete(${symbol})`,
    );

    const records = yahoo.points.map((p) => ({
      symbol,
      price: new Prisma.Decimal(p.price.toFixed(4)),
      changePercent: null,
      timestamp: p.timestamp,
    }));

    for (let i = 0; i < records.length; i += BATCH_INSERT_SIZE) {
      const slice = records.slice(i, i + BATCH_INSERT_SIZE);
      await withDbRetry(
        () => prisma.stockPriceHistory.createMany({ data: slice }),
        `insert(${symbol} batch ${i})`,
      );
    }

    okCount++;
    totalRowsInserted += records.length;
    const first = records[0].timestamp.toISOString().slice(0, 10);
    const last = records[records.length - 1].timestamp.toISOString().slice(0, 10);
    console.log(`${tag} inserted ${records.length} rows (${first} → ${last})`);

    await sleep(THROTTLE_MS);
  }

  console.log(`\nDone: ${okCount} symbols backfilled, ${skipCount} skipped, ${totalRowsInserted} total rows.`);
  if (skipped.length > 0 && skipped.length <= 30) {
    console.log(`Skipped: ${skipped.join(', ')}`);
  } else if (skipped.length > 30) {
    console.log(`Skipped (first 30 of ${skipped.length}): ${skipped.slice(0, 30).join(', ')}…`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
