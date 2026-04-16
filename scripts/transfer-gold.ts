/**
 * Transfers 24K gold transactions from one user to another (or a new user).
 * Run: npx ts-node -r tsconfig-paths/register scripts/transfer-gold.ts
 */
import { PrismaClient, AssetType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const SOURCE_EMAIL = 'ahmedmedhat1231@gmail.com';
const TARGET_EMAIL = 'ayamedhat@gmail.com';
const TARGET_PASSWORD = 'ayamedhat@gmail.com';
const GOLD_24K_SYMBOL = 'GOLD_24K';

async function main() {
  // 1. Find source user
  const sourceUser = await prisma.user.findUnique({ where: { email: SOURCE_EMAIL } });
  if (!sourceUser) {
    throw new Error(`Source user not found: ${SOURCE_EMAIL}`);
  }
  console.log(`Source user found: ${sourceUser.id} (${sourceUser.email})`);

  // 2. Find 24K gold transactions for source user
  const goldTransactions = await prisma.transaction.findMany({
    where: {
      userId: sourceUser.id,
      symbol: GOLD_24K_SYMBOL,
      assetType: AssetType.GOLD,
      deletedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!goldTransactions.length) {
    throw new Error(`No 24K gold transactions found for ${SOURCE_EMAIL}`);
  }
  console.log(`Found ${goldTransactions.length} gold transactions to transfer:`);
  goldTransactions.forEach(t => {
    console.log(`  ${t.type} qty=${t.quantity} price=${t.price} date=${t.createdAt.toISOString()}`);
  });

  // 3. Find or create target user
  let targetUser = await prisma.user.findUnique({ where: { email: TARGET_EMAIL } });
  if (targetUser) {
    console.log(`Target user already exists: ${targetUser.id} (${targetUser.email})`);
  } else {
    const passwordHash = await bcrypt.hash(TARGET_PASSWORD, 10);
    targetUser = await prisma.user.create({
      data: {
        email: TARGET_EMAIL,
        name: 'Aya Medhat',
        passwordHash,
      },
    });
    console.log(`Created new target user: ${targetUser.id} (${targetUser.email})`);
  }

  // 4. Copy transactions to target user (preserving exact dates/quantities/prices)
  console.log('\nCopying transactions to target user...');
  for (const t of goldTransactions) {
    await prisma.transaction.create({
      data: {
        userId: targetUser.id,
        symbol: t.symbol,
        type: t.type,
        assetType: t.assetType,
        quantity: t.quantity,
        price: t.price,
        fees: t.fees,
        createdAt: t.createdAt,
      },
    });
    console.log(`  Copied: ${t.type} qty=${t.quantity} price=${t.price} date=${t.createdAt.toISOString()}`);
  }

  // 5. Rebuild target user's gold position
  const { Decimal } = await import('decimal.js');
  let qty = new Decimal(0);
  let totalInvested = new Decimal(0);

  for (const t of goldTransactions) {
    const tQty = new Decimal(t.quantity.toString());
    const tPrice = new Decimal(t.price.toString());
    const fees = new Decimal(t.fees.toString());
    if (t.type === 'BUY') {
      totalInvested = totalInvested.add(tQty.mul(tPrice).add(fees));
      qty = qty.add(tQty);
    } else {
      qty = qty.sub(tQty);
      if (qty.isZero()) totalInvested = new Decimal(0);
    }
  }

  if (qty.greaterThan(0)) {
    const avgPrice = totalInvested.div(qty);
    await prisma.position.upsert({
      where: { userId_symbol: { userId: targetUser.id, symbol: GOLD_24K_SYMBOL } },
      update: {
        totalQuantity: qty.toFixed(8),
        averagePrice: avgPrice.toFixed(8),
        totalInvested: totalInvested.toFixed(8),
        assetType: AssetType.GOLD,
      },
      create: {
        userId: targetUser.id,
        symbol: GOLD_24K_SYMBOL,
        assetType: AssetType.GOLD,
        totalQuantity: qty.toFixed(8),
        averagePrice: avgPrice.toFixed(8),
        totalInvested: totalInvested.toFixed(8),
      },
    });
    console.log(`\nTarget position set: qty=${qty.toFixed(4)} avgPrice=${avgPrice.toFixed(2)}`);
  }

  // 6. Soft-delete transactions from source user
  console.log('\nRemoving gold transactions from source user...');
  const ids = goldTransactions.map(t => t.id);
  await prisma.transaction.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: new Date() },
  });

  // 7. Remove source user's gold position
  await prisma.position.deleteMany({
    where: { userId: sourceUser.id, symbol: GOLD_24K_SYMBOL },
  });

  console.log('\nDone! 24K gold transferred successfully.');
  console.log(`  From: ${SOURCE_EMAIL}`);
  console.log(`  To:   ${TARGET_EMAIL}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
