import { PrismaClient, TransactionType } from '@prisma/client';
import Decimal from 'decimal.js';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: 'ahmedmedhat1231@gmail.com' },
  });

  if (!user) throw new Error('User not found');

  const userId = user.id;
  console.log(`Rebuilding positions for user: ${userId}`);

  // Clear existing positions and realized gains for this user
  await prisma.realizedGain.deleteMany({ where: { userId } });
  await prisma.position.deleteMany({ where: { userId } });
  console.log('Cleared existing positions and realized gains.');

  // Fetch all transactions ordered chronologically
  const transactions = await prisma.transaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Replaying ${transactions.length} transactions...`);

  // In-memory position state: symbol -> { totalQuantity, averagePrice, totalInvested }
  const positions: Record<string, { qty: Decimal; avgPx: Decimal; totalInv: Decimal }> = {};

  for (const tx of transactions) {
    const { symbol, type } = tx;
    const qty = new Decimal(tx.quantity.toString());
    const px = new Decimal(tx.price.toString());
    const fees = new Decimal((tx as any).fees?.toString() ?? '0');

    if (type === TransactionType.BUY) {
      const buyCost = qty.mul(px).add(fees);
      if (!positions[symbol]) {
        positions[symbol] = {
          qty,
          avgPx: buyCost.div(qty),
          totalInv: buyCost,
        };
      } else {
        const prev = positions[symbol];
        const newQty = prev.qty.add(qty);
        const newInv = prev.totalInv.add(buyCost);
        positions[symbol] = {
          qty: newQty,
          avgPx: newInv.div(newQty),
          totalInv: newInv,
        };
      }
    } else {
      // SELL
      if (!positions[symbol]) {
        throw new Error(`Cannot sell ${symbol}: no position exists`);
      }
      const pos = positions[symbol];
      if (qty.greaterThan(pos.qty)) {
        throw new Error(`Cannot sell ${qty} of ${symbol}: only ${pos.qty} held`);
      }

      const profit = px.sub(pos.avgPx).mul(qty).sub(fees);
      const newQty = pos.qty.sub(qty);
      const newInv = newQty.isZero() ? new Decimal(0) : pos.totalInv.sub(qty.mul(pos.avgPx)).sub(fees);

      // Record realized gain
      await prisma.realizedGain.create({
        data: {
          userId,
          symbol,
          quantity: qty.toFixed(8),
          sellPrice: px.toFixed(8),
          avgPrice: pos.avgPx.toFixed(8),
          profit: profit.toFixed(8),
          fees: fees.toFixed(8),
          createdAt: tx.createdAt,
        },
      });

      positions[symbol] = { qty: newQty, avgPx: pos.avgPx, totalInv: newInv };
    }
  }

  // Write final positions to DB
  for (const [symbol, pos] of Object.entries(positions)) {
    if (pos.qty.isZero()) continue; // skip closed positions

    await prisma.position.upsert({
      where: { userId_symbol: { userId, symbol } },
      create: {
        userId,
        symbol,
        totalQuantity: pos.qty.toFixed(8),
        averagePrice: pos.avgPx.toFixed(8),
        totalInvested: pos.totalInv.toFixed(8),
      },
      update: {
        totalQuantity: pos.qty.toFixed(8),
        averagePrice: pos.avgPx.toFixed(8),
        totalInvested: pos.totalInv.toFixed(8),
      },
    });

    console.log(`  ${symbol}: qty=${pos.qty.toFixed(2)} avgPx=${pos.avgPx.toFixed(4)} invested=${pos.totalInv.toFixed(2)}`);
  }

  console.log('Done!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
