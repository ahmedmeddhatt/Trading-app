import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const txns = await p.transaction.findMany({
    where: { userId: 'e97eedee-8a6b-4d76-84b3-e9928e8061fd', symbol: { in: ['ACGC','ASCM','ETEL','ORAS'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, symbol: true, type: true, quantity: true, price: true, fees: true, createdAt: true },
  });
  for (const t of txns) {
    console.log(`${t.symbol} ${t.type} qty=${t.quantity} px=${t.price} fees=${t.fees} at=${t.createdAt.toISOString()}`);
  }
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
