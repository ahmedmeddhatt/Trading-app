/**
 * Rebuilds positions and realized gains from existing transactions.
 * Run: npx ts-node -r tsconfig-paths/register scripts/rebuild-positions.ts
 */
import { PrismaClient, TransactionType } from '@prisma/client';
import Decimal from 'decimal.js';

const prisma = new PrismaClient();

async function main() {
  const transactions = await prisma.transaction.findMany({
    orderBy: { createdAt: 'asc' },
  });

  if (!transactions.length) {
    console.log('No transactions found.');
    return;
  }

  console.log(`Found ${transactions.length} transactions. Clearing positions & realized gains...`);
  await prisma.realizedGain.deleteMany({});
  await prisma.position.deleteMany({});
  console.log('Cleared.');

  // In-memory position state per user+symbol
  const state: Record<string, { qty: Decimal; avgPrice: Decimal; totalInvested: Decimal }> = {};

  for (const t of transactions) {
    const key = `${t.userId}:${t.symbol}`;
    const qty = new Decimal(t.quantity.toString());
    const px = new Decimal(t.price.toString());
    const fees = new Decimal((t as any).fees?.toString() ?? '0');

    if (t.type === TransactionType.BUY) {
      const buyCost = qty.mul(px).add(fees);
      if (!state[key]) {
        state[key] = { qty, avgPrice: buyCost.div(qty), totalInvested: buyCost };
      } else {
        const s = state[key];
        const newQty = s.qty.add(qty);
        const newInv = s.totalInvested.add(buyCost);
        state[key] = { qty: newQty, avgPrice: newInv.div(newQty), totalInvested: newInv };
      }
    } else {
      // SELL
      if (!state[key]) {
        console.warn(`WARN: SELL without position for ${t.symbol} user ${t.userId} — skipping`);
        continue;
      }
      const s = state[key];
      const profit = px.sub(s.avgPrice).mul(qty).sub(fees);

      await prisma.realizedGain.create({
        data: {
          userId: t.userId,
          symbol: t.symbol,
          quantity: qty.toFixed(8),
          sellPrice: px.toFixed(8),
          avgPrice: s.avgPrice.toFixed(8),
          profit: profit.toFixed(8),
          fees: fees.toFixed(8),
        },
      });

      const newQty = s.qty.sub(qty);
      if (newQty.isZero()) {
        state[key] = { qty: new Decimal(0), avgPrice: s.avgPrice, totalInvested: new Decimal(0) };
      } else {
        state[key] = { qty: newQty, avgPrice: s.avgPrice, totalInvested: newQty.mul(s.avgPrice) };
      }
    }
  }

  // Write final positions (only non-zero qty)
  let created = 0;
  for (const [key, s] of Object.entries(state)) {
    if (s.qty.isZero()) continue;
    const [userId, ...symbolParts] = key.split(':');
    const symbol = symbolParts.join(':');
    await prisma.position.upsert({
      where: { userId_symbol: { userId, symbol } },
      update: { totalQuantity: s.qty.toFixed(8), averagePrice: s.avgPrice.toFixed(8), totalInvested: s.totalInvested.toFixed(8) },
      create: { userId, symbol, totalQuantity: s.qty.toFixed(8), averagePrice: s.avgPrice.toFixed(8), totalInvested: s.totalInvested.toFixed(8) },
    });
    console.log(`  Position: ${symbol} qty=${s.qty.toFixed(2)} avg=${s.avgPrice.toFixed(2)}`);
    created++;
  }

  console.log(`\nDone. ${created} positions rebuilt.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
