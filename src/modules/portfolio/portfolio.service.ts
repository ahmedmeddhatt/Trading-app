import { Injectable } from '@nestjs/common';
import { PositionsService } from '../positions/positions.service';
import { PrismaService } from '../../database/prisma.service';
import { RedisWriterService } from '../scraper/redis-writer.service';
import { Decimal } from '@prisma/client/runtime/library';

export interface PortfolioSummary {
  userId: string;
  totalInvested: string;
  positionCount: number;
  positions: Array<{
    symbol: string;
    totalQuantity: string;
    averagePrice: string;
    totalInvested: string;
  }>;
}

@Injectable()
export class PortfolioService {
  constructor(
    private readonly positionsService: PositionsService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisWriterService,
  ) {}

  async getAnalytics(userId: string) {
    const [positions, realizedGains, feeAgg, allTxns, symbolsResult] = await Promise.all([
      this.positionsService.findByUser(userId),
      this.prisma.realizedGain.findMany({ where: { userId } }),
      this.prisma.transaction.aggregate({
        where: { userId },
        _sum: { fees: true },
      }),
      this.prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { symbol: true, createdAt: true },
      }),
      this.prisma.transaction.findMany({
        where: { userId },
        select: { symbol: true },
        distinct: ['symbol'],
      }),
    ]);

    const totalRealized = realizedGains.reduce(
      (s, r) => s.add(r.profit), new Decimal(0),
    );
    const totalUnrealized = new Decimal(0);

    const totalFeesPaid = new Decimal((feeAgg._sum.fees ?? 0).toString());
    const netPnL = totalRealized.add(totalUnrealized).sub(totalFeesPaid).toFixed(2);
    const symbolsTraded = symbolsResult.length;

    const symbolGroups = new Map<string, { first: Date; last: Date }>();
    for (const t of allTxns) {
      if (!symbolGroups.has(t.symbol)) {
        symbolGroups.set(t.symbol, { first: t.createdAt, last: t.createdAt });
      } else {
        symbolGroups.get(t.symbol)!.last = t.createdAt;
      }
    }
    const today = new Date();
    const holdingDaysList = Array.from(symbolGroups.values()).map(({ first, last }) => {
      const end = last > first ? last : today;
      return (end.getTime() - first.getTime()) / (1000 * 60 * 60 * 24);
    });
    const avgHoldingDays =
      holdingDaysList.length > 0
        ? parseFloat((holdingDaysList.reduce((a, b) => a + b, 0) / holdingDaysList.length).toFixed(1))
        : 0;

    // Fetch graphData for each symbol
    const symbols = positions.map((p) => p.symbol);
    const graphRows = symbols.length > 0
      ? await this.prisma.$queryRaw<Array<{ symbol: string; price: number; timestamp: Date }>>`
          SELECT symbol, price::float8, timestamp
          FROM stock_price_history
          WHERE symbol = ANY(${symbols}::text[])
          ORDER BY timestamp ASC
        `
      : [];

    const graphBySymbol = new Map<string, Array<{ price: string; timestamp: string }>>();
    for (const r of graphRows) {
      if (!graphBySymbol.has(r.symbol)) graphBySymbol.set(r.symbol, []);
      graphBySymbol.get(r.symbol)!.push({
        price: r.price.toString(),
        timestamp: r.timestamp.toISOString(),
      });
    }

    const positionData = positions.map((p) => {
      const qty = new Decimal(p.totalQuantity.toString());
      const avg = new Decimal(p.averagePrice.toString());
      const invested = new Decimal(p.totalInvested.toString());
      const realized = realizedGains
        .filter((r) => r.symbol === p.symbol)
        .reduce((s, r) => s.add(r.profit), new Decimal(0));

      return {
        symbol: p.symbol,
        totalQuantity: qty.toString(),
        averagePrice: avg.toFixed(2),
        totalInvested: invested.toFixed(2),
        currentPrice: parseFloat(avg.toFixed(2)),
        unrealizedPnL: '0.00',
        realizedPnL: realized.toFixed(2),
        returnPercent: '0.00',
        graphData: graphBySymbol.get(p.symbol) ?? [],
      };
    });

    const best = positionData.reduce<typeof positionData[0] | null>(
      (b, p) => (!b || parseFloat(p.unrealizedPnL) > parseFloat(b.unrealizedPnL) ? p : b), null,
    );
    const worst = positionData.reduce<typeof positionData[0] | null>(
      (w, p) => (!w || parseFloat(p.unrealizedPnL) < parseFloat(w.unrealizedPnL) ? p : w), null,
    );

    const winningPositions = positionData.filter((p) => parseFloat(p.realizedPnL) > 0).length;
    const winRate = positionData.length > 0
      ? parseFloat(((winningPositions / positionData.length) * 100).toFixed(2))
      : 0;

    return {
      positions: positionData,
      portfolioValue: {
        totalInvested: positions.reduce((s, p) => s.add(p.totalInvested), new Decimal(0)).toFixed(2),
        totalRealized: totalRealized.toFixed(2),
        totalUnrealized: totalUnrealized.toFixed(2),
        totalPnL: totalRealized.add(totalUnrealized).toFixed(2),
      },
      bestPerformer: best
        ? { symbol: best.symbol, unrealizedPnL: best.unrealizedPnL, returnPercent: best.returnPercent }
        : null,
      worstPerformer: worst
        ? { symbol: worst.symbol, unrealizedPnL: worst.unrealizedPnL, returnPercent: worst.returnPercent }
        : null,
      winRate,
      totalFeesPaid: totalFeesPaid.toFixed(2),
      netPnL,
      avgHoldingDays,
      symbolsTraded,
    };
  }

  async getTimeline(userId: string, from?: string, to?: string) {
    const where: Record<string, unknown> = { userId };
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const txns = await this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

    let runningInvested = new Decimal(0);
    const timeline = txns.map((t) => {
      const amount = new Decimal(t.quantity.toString()).mul(new Decimal(t.price.toString()));
      runningInvested = t.type === 'BUY' ? runningInvested.add(amount) : runningInvested.sub(amount);
      const val = runningInvested.toFixed(2);
      return {
        timestamp: t.createdAt.toISOString(),
        totalValue: val,
        totalInvested: val,
      };
    });

    return { timeline };
  }

  async getAllocation(userId: string) {
    const positions = await this.positionsService.findByUser(userId);
    const stocks = await this.prisma.stock.findMany({
      where: { symbol: { in: positions.map((p) => p.symbol) } },
    });
    const stockMap = new Map(stocks.map((s) => [s.symbol, s]));

    const totalInvested = positions.reduce((s, p) => s.add(p.totalInvested), new Decimal(0));

    const priceMap = await this.redis.hgetall('market:prices');

    const bySectorMap = new Map<string, Decimal>();
    for (const p of positions) {
      const sector = stockMap.get(p.symbol)?.sector ?? 'Unknown';
      bySectorMap.set(sector, (bySectorMap.get(sector) ?? new Decimal(0)).add(p.totalInvested));
    }

    return {
      bySector: Array.from(bySectorMap.entries()).map(([sector, val]) => ({
        sector,
        value: val.toFixed(2),
        percent: totalInvested.isZero() ? 0 : parseFloat(val.div(totalInvested).mul(100).toFixed(2)),
      })),
      bySymbol: positions.map((p) => {
        const invested = new Decimal(p.totalInvested.toString());
        const raw = priceMap[p.symbol];
        const priceData = raw ? JSON.parse(raw) : null;
        return {
          symbol: p.symbol,
          name: stockMap.get(p.symbol)?.name ?? p.symbol,
          value: invested.toFixed(2),
          percent: totalInvested.isZero()
            ? 0
            : parseFloat(invested.div(totalInvested).mul(100).toFixed(2)),
          quantity: new Decimal(p.totalQuantity.toString()).toFixed(8),
          avgPrice: new Decimal(p.averagePrice.toString()).toFixed(2),
          currentPrice: priceData?.price ?? null,
        };
      }),
    };
  }

  async getStockHistory(userId: string, symbol: string) {
    const sym = symbol.toUpperCase();
    const [txns, realizedGains, priceRaw] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { userId, symbol: sym },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.realizedGain.findMany({ where: { userId, symbol: sym } }),
      this.redis.hget('market:prices', sym),
    ]);

    let runningQty = new Decimal(0);
    let runningCost = new Decimal(0);
    let totalBought = new Decimal(0);
    let totalSold = new Decimal(0);
    let totalFees = new Decimal(0);

    const transactions = txns.map((t) => {
      const qty = new Decimal(t.quantity.toString());
      const px = new Decimal(t.price.toString());
      const fees = new Decimal((t as any).fees?.toString() ?? '0');
      const total = qty.mul(px).add(fees);

      if (t.type === 'BUY') {
        runningQty = runningQty.add(qty);
        runningCost = runningCost.add(qty.mul(px)).add(fees);
        totalBought = totalBought.add(total);
      } else {
        if (!runningQty.isZero()) {
          const soldCost = runningCost.mul(qty).div(runningQty);
          runningCost = runningCost.sub(soldCost);
        }
        runningQty = runningQty.sub(qty);
        totalSold = totalSold.add(qty.mul(px));
      }
      totalFees = totalFees.add(fees);

      const runningAvgPrice = runningQty.isZero()
        ? new Decimal(0)
        : runningCost.div(runningQty);

      return {
        id: t.id,
        type: t.type,
        quantity: qty.toFixed(8),
        price: px.toFixed(2),
        fees: fees.toFixed(2),
        total: total.toFixed(2),
        date: t.createdAt.toISOString(),
        runningQuantity: parseFloat(runningQty.toFixed(8)),
        runningAvgPrice: parseFloat(runningAvgPrice.toFixed(2)),
      };
    });

    const realizedPnL = realizedGains.reduce((s, r) => s.add(r.profit), new Decimal(0));
    const averageBuyPrice = runningQty.isZero() ? new Decimal(0) : runningCost.div(runningQty);

    const priceData = priceRaw ? JSON.parse(priceRaw) : null;
    const currentPrice: number | null = priceData?.price ?? null;

    const unrealizedPnL =
      currentPrice !== null && !runningQty.isZero()
        ? new Decimal(currentPrice).sub(averageBuyPrice).mul(runningQty).toFixed(2)
        : null;

    const totalReturn =
      unrealizedPnL !== null && !totalBought.isZero()
        ? parseFloat(
            new Decimal(unrealizedPnL)
              .add(realizedPnL)
              .div(totalBought)
              .mul(100)
              .toFixed(2),
          )
        : null;

    return {
      symbol: sym,
      transactions,
      summary: {
        totalBought: totalBought.toFixed(2),
        totalSold: totalSold.toFixed(2),
        totalFees: totalFees.toFixed(2),
        totalQuantityHeld: parseFloat(runningQty.toFixed(8)),
        averageBuyPrice: averageBuyPrice.toFixed(2),
        realizedPnL: realizedPnL.toFixed(2),
        currentPrice,
        unrealizedPnL,
        totalReturn,
      },
    };
  }

  async getPortfolioSummary(userId: string): Promise<PortfolioSummary> {
    const positions = await this.positionsService.findByUser(userId);

    const totalInvested = positions.reduce(
      (sum, pos) => sum.add(pos.totalInvested),
      new Decimal(0),
    );

    return {
      userId,
      totalInvested: totalInvested.toFixed(2),
      positionCount: positions.length,
      positions: positions.map((pos) => ({
        symbol: pos.symbol,
        totalQuantity: pos.totalQuantity.toString(),
        averagePrice: pos.averagePrice.toFixed(2),
        totalInvested: pos.totalInvested.toFixed(2),
      })),
    };
  }
}
