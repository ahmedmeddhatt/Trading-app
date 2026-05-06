const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const ser = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
(async () => {
  const logs = await p.weeklyPicksLog.findMany({
    where: { lang: 'en' },
    select: { id: true, generatedAt: true, aiProvider: true, aiModel: true, marketCondition: true },
    orderBy: { generatedAt: 'asc' },
  });
  console.log(`weekly_picks_log rows (lang='en'): ${logs.length}`);
  for (const l of logs) console.log(`  ${l.generatedAt.toISOString()} — ${l.aiProvider}/${l.aiModel} — ${l.marketCondition}`);

  const snaps = await p.recommendationSnapshot.findMany({
    select: { weekStartDate: true, generatedAt: true, aiProvider: true, picks: { select: { id: true, symbol: true } } },
    orderBy: { weekStartDate: 'asc' },
  });
  console.log(`\nrecommendation_snapshots: ${snaps.length}`);
  for (const s of snaps) {
    const pickList = s.picks.map((x) => x.symbol).join(',');
    console.log(`  weekStart=${s.weekStartDate.toISOString().slice(0,10)} generatedAt=${s.generatedAt.toISOString()} picks=${s.picks.length} [${pickList}]`);
  }

  // Per-snapshot stats
  const stats = await p.$queryRawUnsafe(`
    SELECT s.week_start_date::text AS week,
           s.ai_provider,
           COUNT(*)::int AS picks,
           SUM(CASE WHEN pp.t1_hit THEN 1 ELSE 0 END)::int AS t1,
           SUM(CASE WHEN pp.t2_hit THEN 1 ELSE 0 END)::int AS t2,
           SUM(CASE WHEN pp.stop_hit THEN 1 ELSE 0 END)::int AS stop,
           ROUND(AVG(pp.return_pct)::numeric, 2)::text AS avg_ret_pct
    FROM recommendation_snapshots s
    JOIN tracked_picks tp ON tp.snapshot_id = s.id
    JOIN pick_performance pp ON pp.pick_id = tp.id
    GROUP BY s.id, s.week_start_date, s.ai_provider
    ORDER BY s.week_start_date
  `);
  console.log('\nPer-week accuracy:');
  for (const r of stats) console.log(`  ${r.week} (${r.ai_provider}): n=${r.picks} t1=${r.t1} t2=${r.t2} stop=${r.stop} avgReturn=${r.avg_ret_pct}%`);

  // Highest-return picks (verify the 116% avg isn't bogus)
  const top = await p.$queryRawUnsafe(`
    SELECT tp.symbol, tp.entry::float8 AS entry, pp.latest_price::float8 AS latest, pp.return_pct::float8 AS ret, pp.status,
           s.week_start_date::text AS week
    FROM pick_performance pp
    JOIN tracked_picks tp ON tp.id = pp.pick_id
    JOIN recommendation_snapshots s ON s.id = tp.snapshot_id
    ORDER BY pp.return_pct DESC NULLS LAST
    LIMIT 8
  `);
  console.log('\nTop returns:');
  for (const r of top) console.log(`  ${r.week} ${r.symbol} entry=${r.entry} latest=${r.latest} return=${r.ret?.toFixed(1)}% [${r.status}]`);

  // Bottom returns
  const bot = await p.$queryRawUnsafe(`
    SELECT tp.symbol, tp.entry::float8 AS entry, pp.latest_price::float8 AS latest, pp.return_pct::float8 AS ret, pp.status,
           s.week_start_date::text AS week
    FROM pick_performance pp
    JOIN tracked_picks tp ON tp.id = pp.pick_id
    JOIN recommendation_snapshots s ON s.id = tp.snapshot_id
    ORDER BY pp.return_pct ASC NULLS LAST
    LIMIT 8
  `);
  console.log('\nBottom returns:');
  for (const r of bot) console.log(`  ${r.week} ${r.symbol} entry=${r.entry} latest=${r.latest} return=${r.ret?.toFixed(1)}% [${r.status}]`);

  await p.$disconnect();
})();
