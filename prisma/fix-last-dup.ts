import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  // The pre-existing ORAS BUY 3@465.7 fees=0 (same timestamp as our fees=22.07 one)
  const dups = await p.transaction.findMany({
    where: {
      userId: 'e97eedee-8a6b-4d76-84b3-e9928e8061fd',
      symbol: 'ORAS',
      type: 'BUY',
      price: 465.7,
    },
    orderBy: { fees: 'desc' }, // keep the one with fees=22.07 first
  });
  console.log('Found ORAS 465.7 entries:', dups.map(d => ({ fees: d.fees.toString(), at: d.createdAt })));
  if (dups.length === 2) {
    // Delete the zero-fees one
    const zeroFees = dups.find(d => parseFloat(d.fees.toString()) === 0);
    if (zeroFees) {
      await p.transaction.delete({ where: { id: zeroFees.id } });
      console.log('Deleted zero-fees duplicate.');
    }
  }
  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
