/**
 * One-shot copy of stocks + gold portfolio data from one user to another.
 *
 * - Stretches transaction timeline so it begins on TARGET_START_DATE
 *   (preserving relative spacing; latest tx stays at "today").
 * - Multiplies quantity / totalInvested / profit by a per-symbol multiplier
 *   uniformly drawn from [6, 8] so the target portfolio is 6-8× the source's
 *   value while staying internally consistent for each symbol.
 * - Source account is NEVER written to.
 * - Target account is wiped of existing tx/positions/gains before copy.
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SOURCE_EMAIL = 'ahmedmedhat1231@gmail.com';
const TARGET_EMAIL = 'ahmedmedhat@gmail.com';
const TARGET_START_DATE = new Date('2021-01-15T00:00:00.000Z');
const MIN_MULT = 6;
const MAX_MULT = 8;

function pickMultiplier(): number {
  return MIN_MULT + Math.random() * (MAX_MULT - MIN_MULT);
}

/**
 * Linearly map a date from the source range to the target range.
 *  src_start → TARGET_START_DATE
 *  src_now   → now()
 */
function makeDateMapper(srcStart: Date, srcNow: Date) {
  const now = new Date();
  const dstSpan = now.getTime() - TARGET_START_DATE.getTime();
  const srcSpan = Math.max(srcNow.getTime() - srcStart.getTime(), 1);
  // Linear interpolation: srcStart→TARGET_START, srcNow→now.
  return (srcDate: Date): Date => {
    const t = (srcDate.getTime() - srcStart.getTime()) / srcSpan;
    return new Date(TARGET_START_DATE.getTime() + t * dstSpan);
  };
}

const D = (n: Prisma.Decimal | number, mult = 1): Prisma.Decimal =>
  new Prisma.Decimal(n.toString()).times(mult);

async function main() {
  const src = await prisma.user.findUnique({ where: { email: SOURCE_EMAIL } });
  const dst = await prisma.user.findUnique({ where: { email: TARGET_EMAIL } });
  if (!src || !dst) {
    throw new Error(`Missing user — src=${!!src} dst=${!!dst}`);
  }
  console.log(`Source: ${src.email} (${src.id})`);
  console.log(`Target: ${dst.email} (${dst.id})`);

  // ── Read source state (read-only) ──────────────────────────────────────
  const [tx, pos, gains] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId: src.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.position.findMany({
      where: { userId: src.id, deletedAt: null },
    }),
    prisma.realizedGain.findMany({
      where: { userId: src.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  if (tx.length === 0) {
    console.log('Source has no transactions — nothing to copy.');
    return;
  }

  // Pick one multiplier per symbol so a symbol's transactions / position /
  // realized gains all scale consistently (BUY × m ↔ SELL × m).
  const symbols = new Set<string>();
  tx.forEach((t) => symbols.add(t.symbol));
  pos.forEach((p) => symbols.add(p.symbol));
  gains.forEach((g) => symbols.add(g.symbol));
  const multBySymbol: Record<string, number> = {};
  for (const s of symbols) multBySymbol[s] = pickMultiplier();
  console.log('\nPer-symbol multipliers:');
  for (const [s, m] of Object.entries(multBySymbol)) {
    console.log(`  ${s.padEnd(15)} ×${m.toFixed(3)}`);
  }

  // Build the date stretcher. Anchor latest source tx ≈ latest copied tx.
  const srcStart = tx[0].createdAt;
  const srcNow = tx[tx.length - 1].createdAt;
  const mapDate = makeDateMapper(srcStart, srcNow);
  console.log(`\nDate stretch: ${srcStart.toISOString()} → ${TARGET_START_DATE.toISOString()}`);
  console.log(`            ${srcNow.toISOString()} → ${new Date().toISOString()}`);

  // ── Wipe target's existing data (clean copy) ───────────────────────────
  const wipe = await prisma.$transaction([
    prisma.realizedGain.deleteMany({ where: { userId: dst.id } }),
    prisma.position.deleteMany({ where: { userId: dst.id } }),
    prisma.transaction.deleteMany({ where: { userId: dst.id } }),
  ]);
  console.log(
    `\nWiped target: ${wipe[2].count} tx · ${wipe[1].count} positions · ${wipe[0].count} realized gains`,
  );

  // ── Copy transactions (price unchanged, quantity scaled, date stretched) ─
  const txData = tx.map((t) => ({
    userId: dst.id,
    symbol: t.symbol,
    type: t.type,
    assetType: t.assetType,
    quantity: D(t.quantity, multBySymbol[t.symbol]),
    price: D(t.price), // price unchanged
    fees: D(t.fees, multBySymbol[t.symbol]),
    createdAt: mapDate(t.createdAt),
  }));
  await prisma.transaction.createMany({ data: txData });
  console.log(`Inserted ${txData.length} transactions`);

  // ── Copy positions ─────────────────────────────────────────────────────
  const posData = pos.map((p) => ({
    userId: dst.id,
    symbol: p.symbol,
    assetType: p.assetType,
    totalQuantity: D(p.totalQuantity, multBySymbol[p.symbol]),
    averagePrice: D(p.averagePrice), // unchanged
    totalInvested: D(p.totalInvested, multBySymbol[p.symbol]),
  }));
  if (posData.length) {
    await prisma.position.createMany({ data: posData });
  }
  console.log(`Inserted ${posData.length} positions`);

  // ── Copy realized gains ────────────────────────────────────────────────
  const gainData = gains.map((g) => ({
    userId: dst.id,
    symbol: g.symbol,
    assetType: g.assetType,
    quantity: D(g.quantity, multBySymbol[g.symbol]),
    sellPrice: D(g.sellPrice),
    avgPrice: D(g.avgPrice),
    profit: D(g.profit, multBySymbol[g.symbol]),
    fees: D(g.fees, multBySymbol[g.symbol]),
    createdAt: mapDate(g.createdAt),
  }));
  if (gainData.length) {
    await prisma.realizedGain.createMany({ data: gainData });
  }
  console.log(`Inserted ${gainData.length} realized gains`);

  // ── Sanity check ───────────────────────────────────────────────────────
  const [tx2, pos2, gains2] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId: dst.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.position.findMany({ where: { userId: dst.id, deletedAt: null } }),
    prisma.realizedGain.findMany({
      where: { userId: dst.id, deletedAt: null },
    }),
  ]);
  console.log('\n── Target after copy ──');
  console.log(`Transactions: ${tx2.length}`);
  if (tx2.length > 0) {
    console.log(`  earliest: ${tx2[0].createdAt.toISOString()}`);
    console.log(`  latest:   ${tx2[tx2.length - 1].createdAt.toISOString()}`);
  }
  console.log(`Positions: ${pos2.length}`);
  console.log(`Realized gains: ${gains2.length}`);

  // Source untouched verification
  const srcTxAfter = await prisma.transaction.count({
    where: { userId: src.id, deletedAt: null },
  });
  console.log(`\nSource still has ${srcTxAfter} tx (expected ${tx.length})`);
  if (srcTxAfter !== tx.length) throw new Error('SOURCE WAS MODIFIED — abort');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
