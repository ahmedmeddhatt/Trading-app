const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const ser = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
(async () => {
  const totalRows = await p.stockPriceHistory.count();
  const distinctSymbols = await p.$queryRawUnsafe(`SELECT COUNT(DISTINCT symbol)::int AS n FROM stock_price_history`);
  console.log(`Total rows: ${totalRows}, distinct symbols: ${distinctSymbols[0].n}`);

  const stats = await p.$queryRawUnsafe(`
    SELECT symbol,
           COUNT(*)::int AS rows,
           COUNT(DISTINCT price)::int AS distinct_closes,
           MIN(price)::float8 AS min_p,
           MAX(price)::float8 AS max_p,
           ROUND((MAX(price) - MIN(price))::numeric / NULLIF(MIN(price), 0)::numeric * 100, 1)::text AS spread_pct,
           MIN(timestamp)::date AS first,
           MAX(timestamp)::date AS last
    FROM stock_price_history
    WHERE symbol IN ('COMI','EFIH','ETEL','HRHO','SWDY','EKHO','PHAR','TMGH','ACGC','IRON','SKPC','ESRS','ORAS','ABUK','MASR')
    GROUP BY symbol
    ORDER BY symbol
  `);
  console.log('\nSanity check on key symbols:');
  for (const r of stats) {
    console.log(`  ${r.symbol.padEnd(6)} rows=${r.rows.toString().padStart(4)} distinct=${r.distinct_closes.toString().padStart(4)} min=${r.min_p.toFixed(2).padStart(8)} max=${r.max_p.toFixed(2).padStart(8)} spread=${r.spread_pct}% (${r.first} → ${r.last})`);
  }

  // ORAS specifically (should have 0 rows now)
  const orasCount = await p.stockPriceHistory.count({ where: { symbol: 'ORAS' } });
  console.log(`\nORAS row count after wipe: ${orasCount}`);

  await p.$disconnect();
})();
