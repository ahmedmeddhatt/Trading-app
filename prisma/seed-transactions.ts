import { PrismaClient, TransactionType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: 'ahmedmedhat1231@gmail.com' },
  });

  if (!user) {
    throw new Error('User not found: ahmedmedhat1231@gmail.com');
  }

  console.log(`Found user: ${user.id}`);

  const transactions: {
    userId: string;
    symbol: string;
    type: TransactionType;
    quantity: number;
    price: number;
    fees: number;
    createdAt: Date;
  }[] = [
    // MFPC
    { userId: user.id, symbol: 'MFPC', type: 'BUY',  quantity: 1,  price: 29.86, fees: 3.05,  createdAt: new Date('2025-10-23T10:00:00Z') },
    { userId: user.id, symbol: 'MFPC', type: 'SELL', quantity: 1,  price: 29.46, fees: 3.05,  createdAt: new Date('2025-11-02T10:00:00Z') },
    { userId: user.id, symbol: 'MFPC', type: 'BUY',  quantity: 1,  price: 29.86, fees: 3.05,  createdAt: new Date('2025-10-23T10:01:00Z') },
    // ARVA
    { userId: user.id, symbol: 'ARVA', type: 'BUY',  quantity: 3,  price: 7.69,  fees: 3.04,  createdAt: new Date('2025-10-31T10:00:00Z') },
    { userId: user.id, symbol: 'ARVA', type: 'SELL', quantity: 3,  price: 8.56,  fees: 3.05,  createdAt: new Date('2025-12-16T10:00:00Z') },
    // AIFI
    { userId: user.id, symbol: 'AIFI', type: 'BUY',  quantity: 11, price: 1.91,  fees: 3.04,  createdAt: new Date('2025-10-31T10:01:00Z') },
    { userId: user.id, symbol: 'AIFI', type: 'SELL', quantity: 11, price: 2.85,  fees: 3.05,  createdAt: new Date('2025-12-04T10:00:00Z') },
    // MCRO
    { userId: user.id, symbol: 'MCRO', type: 'BUY',  quantity: 5,  price: 3.64,  fees: 3.04,  createdAt: new Date('2025-10-31T10:02:00Z') },
    { userId: user.id, symbol: 'MCRO', type: 'BUY',  quantity: 58, price: 1.12,  fees: 3.09,  createdAt: new Date('2025-11-23T10:00:00Z') },
    { userId: user.id, symbol: 'MCRO', type: 'SELL', quantity: 5,  price: 3.71,  fees: 3.11,  createdAt: new Date('2025-11-05T10:00:00Z') },
    { userId: user.id, symbol: 'MCRO', type: 'SELL', quantity: 58, price: 1.33,  fees: 3.05,  createdAt: new Date('2025-11-26T10:00:00Z') },
    // MFPC sell duplicate
    { userId: user.id, symbol: 'MFPC', type: 'SELL', quantity: 1,  price: 29.46, fees: 3.05,  createdAt: new Date('2025-11-02T10:01:00Z') },
    // AALR
    { userId: user.id, symbol: 'AALR', type: 'BUY',  quantity: 1,  price: 211.9, fees: 3.26,  createdAt: new Date('2025-11-03T10:00:00Z') },
    { userId: user.id, symbol: 'AALR', type: 'SELL', quantity: 1,  price: 192,   fees: 3.24,  createdAt: new Date('2025-12-17T10:00:00Z') },
    // NIPH
    { userId: user.id, symbol: 'NIPH', type: 'BUY',  quantity: 4,  price: 106.69, fees: 3.58, createdAt: new Date('2025-11-09T10:00:00Z') },
    { userId: user.id, symbol: 'NIPH', type: 'BUY',  quantity: 4,  price: 114.74, fees: 3.53, createdAt: new Date('2025-11-11T10:00:00Z') },
    { userId: user.id, symbol: 'NIPH', type: 'BUY',  quantity: 3,  price: 104.47, fees: 3.39, createdAt: new Date('2025-11-19T10:00:00Z') },
    { userId: user.id, symbol: 'NIPH', type: 'SELL', quantity: 11, price: 105,    fees: 34.46, createdAt: new Date('2026-01-20T10:00:00Z') },
    // AMES
    { userId: user.id, symbol: 'AMES', type: 'BUY',  quantity: 5,  price: 60,    fees: 3.38,  createdAt: new Date('2025-11-09T10:01:00Z') },
    { userId: user.id, symbol: 'AMES', type: 'SELL', quantity: 5,  price: 59.25, fees: 3.37,  createdAt: new Date('2025-12-17T10:01:00Z') },
    // MPCI
    { userId: user.id, symbol: 'MPCI', type: 'BUY',  quantity: 3,  price: 178.69, fees: 3.67, createdAt: new Date('2025-11-09T10:02:00Z') },
    { userId: user.id, symbol: 'MPCI', type: 'BUY',  quantity: 2,  price: 194.79, fees: 3.49, createdAt: new Date('2025-11-11T10:01:00Z') },
    { userId: user.id, symbol: 'MPCI', type: 'SELL', quantity: 5,  price: 162,    fees: 4.01, createdAt: new Date('2026-03-04T10:00:00Z') },
    // OLFI
    { userId: user.id, symbol: 'OLFI', type: 'BUY',  quantity: 20, price: 23.89, fees: 3.6,   createdAt: new Date('2025-11-09T10:03:00Z') },
    { userId: user.id, symbol: 'OLFI', type: 'SELL', quantity: 20, price: 24.8,  fees: 3.62,  createdAt: new Date('2025-12-16T10:01:00Z') },
    // SCEM
    { userId: user.id, symbol: 'SCEM', type: 'BUY',  quantity: 7,  price: 66.8,  fees: 3.59,  createdAt: new Date('2025-11-09T10:04:00Z') },
    { userId: user.id, symbol: 'SCEM', type: 'BUY',  quantity: 2,  price: 66.78, fees: 3.16,  createdAt: new Date('2025-11-11T10:02:00Z') },
    { userId: user.id, symbol: 'SCEM', type: 'SELL', quantity: 9,  price: 62.21, fees: 3.71,  createdAt: new Date('2025-12-17T10:02:00Z') },
    // EGAL
    { userId: user.id, symbol: 'EGAL', type: 'BUY',  quantity: 2,  price: 205,   fees: 3.51,  createdAt: new Date('2025-12-04T10:01:00Z') },
    { userId: user.id, symbol: 'EGAL', type: 'SELL', quantity: 2,  price: 208.3, fees: 3.52,  createdAt: new Date('2025-12-16T10:02:00Z') },
    // SWDY
    { userId: user.id, symbol: 'SWDY', type: 'BUY',  quantity: 2,  price: 72,    fees: 3.17,  createdAt: new Date('2025-12-04T10:02:00Z') },
    { userId: user.id, symbol: 'SWDY', type: 'SELL', quantity: 2,  price: 76.55, fees: 3.2,   createdAt: new Date('2025-12-16T10:03:00Z') },
    // ALUM
    { userId: user.id, symbol: 'ALUM', type: 'BUY',  quantity: 35, price: 19.7,  fees: 3.86,  createdAt: new Date('2026-02-15T10:00:00Z') },
    { userId: user.id, symbol: 'ALUM', type: 'SELL', quantity: 35, price: 22,    fees: 3.97,  createdAt: new Date('2026-03-04T10:01:00Z') },
    // ACGC
    { userId: user.id, symbol: 'ACGC', type: 'BUY',  quantity: 50, price: 8.0,   fees: 3.5,   createdAt: new Date('2026-02-10T10:00:00Z') },
    // ASCM
    { userId: user.id, symbol: 'ASCM', type: 'BUY',  quantity: 13, price: 44.0,  fees: 3.72,  createdAt: new Date('2026-02-15T10:01:00Z') },
    { userId: user.id, symbol: 'ASCM', type: 'BUY',  quantity: 25, price: 38.0,  fees: 4.2,   createdAt: new Date('2026-02-27T10:00:00Z') },
    // ETEL
    { userId: user.id, symbol: 'ETEL', type: 'BUY',  quantity: 6,  price: 90.39, fees: 3.67,  createdAt: new Date('2026-02-16T10:00:00Z') },
    { userId: user.id, symbol: 'ETEL', type: 'BUY',  quantity: 5,  price: 86.0,  fees: 3.53,  createdAt: new Date('2026-03-04T10:02:00Z') },
    { userId: user.id, symbol: 'ETEL', type: 'BUY',  quantity: 2,  price: 82.5,  fees: 3.22,  createdAt: new Date('2026-03-11T10:00:00Z') },
    // ORAS
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 1,  price: 464.8, fees: 3.61,  createdAt: new Date('2025-10-02T10:00:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 1,  price: 491.9, fees: 3.58,  createdAt: new Date('2025-11-12T10:00:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 11, price: 477.0, fees: 0,     createdAt: new Date('2025-12-11T08:07:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 8,  price: 477,   fees: 0,     createdAt: new Date('2025-12-11T08:10:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 3,  price: 465.7, fees: 22.07, createdAt: new Date('2025-12-11T10:39:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 3,  price: 437,   fees: 34.64, createdAt: new Date('2025-12-17T10:00:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 3,  price: 442,   fees: 3.66,  createdAt: new Date('2025-12-16T10:04:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'SELL', quantity: 3,  price: 487,   fees: 4.83,  createdAt: new Date('2026-02-12T10:00:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'SELL', quantity: 12, price: 498.08, fees: 10.48, createdAt: new Date('2026-02-23T10:00:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 5,  price: 466,   fees: 5.91,  createdAt: new Date('2026-03-01T10:00:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 1,  price: 460,   fees: 0,     createdAt: new Date('2026-03-09T01:27:00Z') },
    { userId: user.id, symbol: 'ORAS', type: 'BUY',  quantity: 2,  price: 452,   fees: 7.71,  createdAt: new Date('2026-03-09T09:26:00Z') },
    // ASCM sell
    { userId: user.id, symbol: 'ASCM', type: 'SELL', quantity: 38, price: 41.5,  fees: 4.98,  createdAt: new Date('2026-03-24T10:00:00Z') },
    // ORAS sell
    { userId: user.id, symbol: 'ORAS', type: 'SELL', quantity: 23, price: 490,   fees: 17.09, createdAt: new Date('2026-03-25T09:26:00Z') },
  ];

  console.log(`Inserting ${transactions.length} transactions...`);

  for (const tx of transactions) {
    await prisma.transaction.create({ data: tx });
  }

  console.log('Done!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
