/**
 * One-shot discovery script — checks both accounts exist and prints summary
 * stats for the source so we know what we're about to copy.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SOURCE = 'ahmedmedhat1231@gmail.com';
const TARGET = 'ahmedmedhat@gmail.com';

async function main() {
  const src = await prisma.user.findUnique({
    where: { email: SOURCE },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  const dst = await prisma.user.findUnique({
    where: { email: TARGET },
    select: { id: true, email: true, name: true, createdAt: true },
  });

  console.log('SOURCE user:', src);
  console.log('TARGET user:', dst);

  if (!src) {
    console.log('Source user not found — aborting.');
    return;
  }

  const [tx, pos, gains] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId: src.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.position.findMany({ where: { userId: src.id, deletedAt: null } }),
    prisma.realizedGain.findMany({
      where: { userId: src.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  console.log(`\nSource transactions: ${tx.length}`);
  if (tx.length > 0) {
    console.log(`  earliest: ${tx[0].createdAt.toISOString()}`);
    console.log(`  latest:   ${tx[tx.length - 1].createdAt.toISOString()}`);
    const byType: Record<string, number> = {};
    for (const t of tx) {
      byType[t.assetType + ':' + t.type] =
        (byType[t.assetType + ':' + t.type] ?? 0) + 1;
    }
    console.log('  by type:', byType);
  }
  console.log(`Source positions: ${pos.length}`);
  console.log(`Source realized gains: ${gains.length}`);

  if (dst) {
    const [tx2, pos2, gains2] = await Promise.all([
      prisma.transaction.count({ where: { userId: dst.id, deletedAt: null } }),
      prisma.position.count({ where: { userId: dst.id, deletedAt: null } }),
      prisma.realizedGain.count({
        where: { userId: dst.id, deletedAt: null },
      }),
    ]);
    console.log(
      `\nTARGET currently has: ${tx2} tx, ${pos2} positions, ${gains2} realized gains`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
