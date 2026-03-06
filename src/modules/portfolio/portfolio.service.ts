import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PositionsService } from '../positions/positions.service';
import { RedisService } from '../../common/redis/redis.service';
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
    private readonly redis: RedisService,
  ) {}

  // ── Helpers ───────────────────────────────────────────────────────────────

  private parseLivePrice(rawPrices: Record<string, string>, symbol: string): Decimal | null {
    try {
      const parsed = rawPrices?.[symbol] ? JSON.parse(rawPrices[symbol]) : null;
      return parsed?.price != null ? new Decimal(parsed.price) : null;
    } catch { return null; }
  }

  private parseLivePriceFull(rawPrices: Record<string, string>, symbol: string) {
    try {
      const parsed = rawPrices?.[symbol] ? JSON.parse(rawPrices[symbol]) : null;
      return { price: parsed?.price ?? null, lastPriceUpdate: parsed?.timestamp ?? null };
    } catch { return { price: null, lastPriceUpdate: null }; }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  async getPortfolioSummary(userId: string): Promise<PortfolioSummary> {
    const positions = await this.positionsService.findByUser(userId);
    const totalInvested = positions.reduce((sum, pos) => sum.add(pos.totalInvested), new Decimal(0));
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

  // ── Analytics (enhanced) ──────────────────────────────────────────────────

  async getAnalytics(userId: string) {
    const [positions, realizedGains, rawPrices] = await Promise.all([
      this.positionsService.findByUser(userId),
      this.prisma.realizedGain.findMany({ where: { userId } }),
      this.redis.hgetall('market:prices'),
    ]);

    const realizedBySymbol: Record<string, Decimal> = {};
    for (const g of realizedGains) {
      realizedBySymbol[g.symbol] = (realizedBySymbol[g.symbol] ?? new Decimal(0)).add(g.profit);
    }

    const symbols = positions.map((p) => p.symbol);
    const history = symbols.length
      ? await this.prisma.stockPriceHistory.findMany({
          where: { symbol: { in: symbols } },
          orderBy: { timestamp: 'asc' },
          select: { symbol: true, price: true, timestamp: true },
        })
      : [];

    const historyBySymbol: Record<string, { price: string; timestamp: Date }[]> = {};
    for (const h of history) {
      (historyBySymbol[h.symbol] ??= []).push({ price: h.price.toString(), timestamp: h.timestamp });
    }

    let totalInvested = new Decimal(0);
    let totalUnrealized = new Decimal(0);
    let totalRealized = new Decimal(0);

    type PosData = {
      symbol: string; totalQuantity: string; averagePrice: string; totalInvested: string;
      currentPrice: number | null; lastPriceUpdate: string | null;
      unrealizedPnL: string | null; unrealizedRaw: Decimal | null;
      realizedPnL: string; graphData: { price: string; timestamp: Date }[];
      returnPercent: number | null;
    };

    const positionData: PosData[] = positions.map((pos) => {
      const qty = new Decimal(pos.totalQuantity.toString());
      const avgPx = new Decimal(pos.averagePrice.toString());
      const invested = new Decimal(pos.totalInvested.toString());
      const { price, lastPriceUpdate } = this.parseLivePriceFull(rawPrices, pos.symbol);
      const currPx = price != null ? new Decimal(price) : null;
      const unrealizedRaw = currPx ? currPx.sub(avgPx).mul(qty) : null;
      const realized = realizedBySymbol[pos.symbol] ?? new Decimal(0);
      const returnPercent = invested.isZero() || !unrealizedRaw
        ? null
        : unrealizedRaw.div(invested).mul(100).toNumber();

      totalInvested = totalInvested.add(invested);
      if (unrealizedRaw) totalUnrealized = totalUnrealized.add(unrealizedRaw);
      totalRealized = totalRealized.add(realized);

      return {
        symbol: pos.symbol,
        totalQuantity: qty.toString(),
        averagePrice: avgPx.toFixed(2),
        totalInvested: invested.toFixed(2),
        currentPrice: price,
        lastPriceUpdate,
        unrealizedPnL: unrealizedRaw?.toFixed(2) ?? null,
        unrealizedRaw,
        realizedPnL: realized.toFixed(2),
        graphData: historyBySymbol[pos.symbol] ?? [],
        returnPercent,
      };
    });

    // best/worst performer
    const withUnrealized = positionData.filter((p) => p.unrealizedRaw != null);
    const best = withUnrealized.length
      ? withUnrealized.reduce((a, b) => (a.unrealizedRaw!.gt(b.unrealizedRaw!) ? a : b))
      : null;
    const worst = withUnrealized.length
      ? withUnrealized.reduce((a, b) => (a.unrealizedRaw!.lt(b.unrealizedRaw!) ? a : b))
      : null;

    // winRate
    const closedPositions = realizedGains.length;
    const winners = realizedGains.filter((g) => new Decimal(g.profit.toString()).gt(0)).length;
    const winRate = closedPositions > 0 ? ((winners / closedPositions) * 100).toFixed(1) : null;

    const totalPnL = totalRealized.add(totalUnrealized);
    const totalPortfolioReturn = totalInvested.isZero()
      ? null
      : totalPnL.div(totalInvested).mul(100).toFixed(2);

    // strip internal unrealizedRaw before returning
    const cleanPositions = positionData.map(({ unrealizedRaw: _r, returnPercent: _rp, ...rest }) => rest);

    return {
      positions: cleanPositions,
      portfolioValue: {
        totalInvested: totalInvested.toFixed(2),
        totalRealized: totalRealized.toFixed(2),
        totalUnrealized: totalUnrealized.toFixed(2),
        totalPnL: totalPnL.toFixed(2),
        totalPortfolioReturn: totalPortfolioReturn ? `${totalPortfolioReturn}%` : null,
      },
      bestPerformer: best
        ? { symbol: best.symbol, unrealizedPnL: best.unrealizedPnL, returnPercent: best.returnPercent }
        : null,
      worstPerformer: worst
        ? { symbol: worst.symbol, unrealizedPnL: worst.unrealizedPnL, returnPercent: worst.returnPercent }
        : null,
      winRate: winRate ? `${winRate}%` : null,
    };
  }

  // ── Stock Transaction History ─────────────────────────────────────────────

  async getStockHistory(userId: string, symbol: string) {
    const [transactions, position, realizedGains] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { userId, symbol },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.position.findUnique({ where: { userId_symbol: { userId, symbol } } }),
      this.prisma.realizedGain.findMany({ where: { userId, symbol } }),
    ]);

    let totalBought = new Decimal(0);
    let totalSold = new Decimal(0);
    let realizedPnL = new Decimal(0);

    for (const t of transactions) {
      const total = new Decimal(t.quantity.toString()).mul(t.price.toString());
      if (t.type === 'BUY') totalBought = totalBought.add(total);
      else totalSold = totalSold.add(total);
    }
    for (const g of realizedGains) realizedPnL = realizedPnL.add(g.profit);

    return {
      symbol,
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        quantity: t.quantity.toString(),
        price: new Decimal(t.price.toString()).toFixed(2),
        total: new Decimal(t.quantity.toString()).mul(t.price.toString()).toFixed(2),
        createdAt: t.createdAt,
      })),
      summary: {
        totalBought: totalBought.toFixed(2),
        totalSold: totalSold.toFixed(2),
        totalQuantityHeld: position?.totalQuantity.toString() ?? '0',
        averageBuyPrice: position?.averagePrice.toFixed(2) ?? '0.00',
        realizedPnL: realizedPnL.toFixed(2),
      },
    };
  }

  // ── Portfolio Timeline ────────────────────────────────────────────────────

  async getTimeline(userId: string, from: Date, to: Date) {
    const positions = await this.positionsService.findByUser(userId);
    if (!positions.length) return { timeline: [] };

    const symbols = positions.map((p) => p.symbol);
    const qtyBySymbol: Record<string, Decimal> = {};
    let totalInvested = new Decimal(0);
    for (const p of positions) {
      qtyBySymbol[p.symbol] = new Decimal(p.totalQuantity.toString());
      totalInvested = totalInvested.add(p.totalInvested);
    }

    const history = await this.prisma.stockPriceHistory.findMany({
      where: { symbol: { in: symbols }, timestamp: { gte: from, lte: to } },
      orderBy: { timestamp: 'asc' },
      select: { symbol: true, price: true, timestamp: true },
    });

    const byTimestamp = new Map<string, Record<string, Decimal>>();
    for (const h of history) {
      const key = h.timestamp.toISOString();
      if (!byTimestamp.has(key)) byTimestamp.set(key, {});
      byTimestamp.get(key)![h.symbol] = new Decimal(h.price.toString());
    }

    const timeline = Array.from(byTimestamp.entries()).map(([timestamp, priceMap]) => {
      let totalValue = new Decimal(0);
      for (const symbol of symbols) {
        const px = priceMap[symbol];
        if (px) totalValue = totalValue.add(px.mul(qtyBySymbol[symbol]));
      }
      return { timestamp, totalValue: totalValue.toFixed(2), totalInvested: totalInvested.toFixed(2) };
    });

    return { timeline };
  }

  // ── Portfolio Allocation ──────────────────────────────────────────────────

  async getAllocation(userId: string) {
    const positions = await this.positionsService.findByUser(userId);
    if (!positions.length) return { bySector: [], bySymbol: [] };

    const symbols = positions.map((p) => p.symbol);
    const [stocksData, rawPrices] = await Promise.all([
      this.prisma.stock.findMany({ where: { symbol: { in: symbols } }, select: { symbol: true, sector: true } }),
      this.redis.hgetall('market:prices'),
    ]);

    const sectorMap: Record<string, string> = {};
    for (const s of stocksData) sectorMap[s.symbol] = s.sector ?? 'Unknown';

    let totalValue = new Decimal(0);
    const items: { symbol: string; value: Decimal; qty: Decimal; avgPx: Decimal; currPx: Decimal | null }[] = [];

    for (const pos of positions) {
      const qty = new Decimal(pos.totalQuantity.toString());
      const avgPx = new Decimal(pos.averagePrice.toString());
      const currPx = this.parseLivePrice(rawPrices, pos.symbol);
      const effectivePx = currPx ?? avgPx;
      const value = qty.mul(effectivePx);
      totalValue = totalValue.add(value);
      items.push({ symbol: pos.symbol, value, qty, avgPx, currPx });
    }

    const sectorValues: Record<string, Decimal> = {};
    for (const item of items) {
      const sector = sectorMap[item.symbol] ?? 'Unknown';
      sectorValues[sector] = (sectorValues[sector] ?? new Decimal(0)).add(item.value);
    }

    const pct = (v: Decimal) => totalValue.isZero() ? '0.00' : v.div(totalValue).mul(100).toFixed(2);

    const bySector = Object.entries(sectorValues)
      .map(([sector, value]) => ({ sector, value: value.toFixed(2), percent: pct(value) }))
      .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

    const bySymbol = items
      .map((item) => ({
        symbol: item.symbol,
        value: item.value.toFixed(2),
        percent: pct(item.value),
        quantity: item.qty.toString(),
        avgPrice: item.avgPx.toFixed(2),
        currentPrice: item.currPx?.toFixed(2) ?? null,
      }))
      .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

    return { bySector, bySymbol };
  }
}
