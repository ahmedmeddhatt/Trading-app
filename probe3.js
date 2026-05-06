const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  // Sample ORAS prices monthly to spot any obvious anomaly
  const oras = await p.$queryRawUnsafe(`
    WITH monthly AS (
      SELECT DATE_TRUNC('month', timestamp) AS m,
             MIN(timestamp) AS first_ts,
             MAX(timestamp) AS last_ts,
             MIN(price)::float8 AS min_p,
             MAX(price)::float8 AS max_p,
             AVG(price)::float8 AS avg_p,
             COUNT(*)::int AS n
      FROM stock_price_history
      WHERE symbol = 'ORAS'
      GROUP BY 1
      ORDER BY 1
    )
    SELECT m::date AS month, n, ROUND(min_p::numeric, 2)::text AS min, ROUND(max_p::numeric, 2)::text AS max, ROUND(avg_p::numeric, 2)::text AS avg
    FROM monthly
  `);
  console.log('ORAS monthly aggregates:');
  for (const r of oras) console.log(`  ${r.month}: n=${r.n}  min=${r.min}  max=${r.max}  avg=${r.avg}`);

  // First and last 5 daily prices
  const firstFive = await p.stockPriceHistory.findMany({
    where: { symbol: 'ORAS' },
    orderBy: { timestamp: 'asc' },
    take: 5,
    select: { price: true, timestamp: true },
  });
  console.log('\nORAS first 5 daily prices:');
  for (const r of firstFive) console.log(`  ${r.timestamp.toISOString()}: ${Number(r.price).toFixed(4)}`);

  const lastFive = await p.stockPriceHistory.findMany({
    where: { symbol: 'ORAS' },
    orderBy: { timestamp: 'desc' },
    take: 5,
    select: { price: true, timestamp: true },
  });
  console.log('\nORAS last 5 daily prices:');
  for (const r of lastFive) console.log(`  ${r.timestamp.toISOString()}: ${Number(r.price).toFixed(4)}`);

  // Same for ESRS — also flagged with huge return
  const esrs = await p.$queryRawUnsafe(`
    WITH monthly AS (
      SELECT DATE_TRUNC('month', timestamp) AS m,
             AVG(price)::float8 AS avg_p,
             COUNT(*)::int AS n
      FROM stock_price_history
      WHERE symbol = 'ESRS'
      GROUP BY 1
      ORDER BY 1
    )
    SELECT m::date AS month, n, ROUND(avg_p::numeric, 2)::text AS avg
    FROM monthly
  `);
  console.log('\nESRS monthly avg:');
  for (const r of esrs) console.log(`  ${r.month}: n=${r.n}  avg=${r.avg}`);

  await p.$disconnect();
})();
