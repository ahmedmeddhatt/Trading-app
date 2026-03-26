import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const userId = 'e97eedee-8a6b-4d76-84b3-e9928e8061fd';

async function main() {
  // Fetch all transactions for the affected symbols
  const txns = await p.transaction.findMany({
    where: { userId, symbol: { in: ['ACGC', 'ASCM', 'ETEL', 'ORAS'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, symbol: true, type: true, quantity: true, price: true, fees: true, createdAt: true },
  });

  const toDelete: string[] = [];

  for (const t of txns) {
    const fees = parseFloat(t.fees.toString());
    const hour = t.createdAt.getUTCHours();
    const min = t.createdAt.getUTCMinutes();

    // Rule 1: midnight entries (pre-existing old API inserts without fees)
    if (hour === 0 && min === 0) {
      toDelete.push(t.id);
      console.log(`DELETE (midnight): ${t.symbol} ${t.type} qty=${t.quantity} px=${t.price} fees=${fees} at=${t.createdAt.toISOString()}`);
      continue;
    }

    // Rule 2: ORAS SELL 23 @ 489.26 (wrong price from app)
    if (t.symbol === 'ORAS' && t.type === 'SELL' && parseFloat(t.price.toString()) === 489.26) {
      toDelete.push(t.id);
      console.log(`DELETE (wrong price): ${t.symbol} ${t.type} qty=${t.quantity} px=${t.price} fees=${fees} at=${t.createdAt.toISOString()}`);
      continue;
    }

    // Rule 3: ASCM SELL 38 @ 41.37 (wrong price from app)
    if (t.symbol === 'ASCM' && t.type === 'SELL' && parseFloat(t.price.toString()) === 41.37) {
      toDelete.push(t.id);
      console.log(`DELETE (wrong price): ${t.symbol} ${t.type} qty=${t.quantity} px=${t.price} fees=${fees} at=${t.createdAt.toISOString()}`);
      continue;
    }

    // Rule 4: ORAS BUY 1@460 at 23:27 UTC (pre-existing, timezone-shifted duplicate of our 01:27 entry)
    if (t.symbol === 'ORAS' && t.type === 'BUY' && parseFloat(t.price.toString()) === 460 && hour === 23 && min === 27) {
      toDelete.push(t.id);
      console.log(`DELETE (tz duplicate): ${t.symbol} ${t.type} qty=${t.quantity} px=${t.price} fees=${fees} at=${t.createdAt.toISOString()}`);
      continue;
    }

    // Rule 5: ORAS BUY 2@452 fees=0 at 09:26 (pre-existing duplicate of our fees=7.71 entry)
    if (t.symbol === 'ORAS' && t.type === 'BUY' && parseFloat(t.price.toString()) === 452 && fees === 0) {
      toDelete.push(t.id);
      console.log(`DELETE (zero-fees dup): ${t.symbol} ${t.type} qty=${t.quantity} px=${t.price} fees=${fees} at=${t.createdAt.toISOString()}`);
      continue;
    }

    // Rule 6: ORAS BUY 11@477 and BUY 8@477 — each appears twice with fees=0, keep first, delete second
    // (both are identical, just pick one)
    // handled below via dedup logic
  }

  // Handle the ORAS BUY 11@477 08:07 duplicate (two identical rows, keep one)
  const oras477_11 = txns.filter(t => t.symbol === 'ORAS' && t.type === 'BUY' && parseFloat(t.price.toString()) === 477 && parseInt(t.quantity.toString()) === 11);
  if (oras477_11.length === 2) {
    toDelete.push(oras477_11[1].id); // delete the second one
    console.log(`DELETE (dup): ORAS BUY 11@477 second copy`);
  }

  // Handle the ORAS BUY 8@477 08:10 duplicate
  const oras477_8 = txns.filter(t => t.symbol === 'ORAS' && t.type === 'BUY' && parseFloat(t.price.toString()) === 477 && parseInt(t.quantity.toString()) === 8);
  if (oras477_8.length === 2) {
    toDelete.push(oras477_8[1].id);
    console.log(`DELETE (dup): ORAS BUY 8@477 second copy`);
  }

  // Remove deduplicated entries already in toDelete
  const uniqueToDelete = [...new Set(toDelete)];
  console.log(`\nDeleting ${uniqueToDelete.length} transactions...`);

  await p.transaction.deleteMany({ where: { id: { in: uniqueToDelete } } });
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
