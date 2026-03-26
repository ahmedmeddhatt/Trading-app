import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const txns = await p.transaction.findMany({
    where: { userId: 'e97eedee-8a6b-4d76-84b3-e9928e8061fd' },
    orderBy: { createdAt: 'asc' },
    select: { symbol: true, type: true, quantity: true, createdAt: true },
  });
  const counts: Record<string, { BUY: number; SELL: number }> = {};
  for (const t of txns) {
    if (!counts[t.symbol]) counts[t.symbol] = { BUY: 0, SELL: 0 };
    counts[t.symbol][t.type]++;
  }
  console.log('Total transactions:', txns.length);
  console.log('Per symbol:');
  for (const [sym, c] of Object.entries(counts).sort()) {
    console.log(`  ${sym}: BUY=${c.BUY} SELL=${c.SELL}`);
  }
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
