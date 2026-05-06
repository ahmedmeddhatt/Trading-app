const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const range = await p.$queryRawUnsafe(
    `SELECT MIN(timestamp)::date AS earliest, MAX(timestamp)::date AS latest,
            COUNT(DISTINCT timestamp::date)::int AS distinct_days,
            COUNT(*)::int AS total_rows,
            COUNT(DISTINCT symbol)::int AS distinct_symbols
     FROM stock_price_history`,
  );
  console.log('RANGE:', JSON.stringify(range, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));

  const sym = await p.$queryRawUnsafe(
    `SELECT symbol, COUNT(*)::int AS days,
            MIN(timestamp)::date AS first_seen, MAX(timestamp)::date AS last_seen
     FROM stock_price_history
     WHERE symbol IN ('ORAS','PHAR','EKHO','SKPC','TMGH','IRON','ACGC')
     GROUP BY symbol ORDER BY symbol`,
  );
  console.log('PICKED SYMBOLS:', JSON.stringify(sym, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));

  await p.$disconnect();
})();
