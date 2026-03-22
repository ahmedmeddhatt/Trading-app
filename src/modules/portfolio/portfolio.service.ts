import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PositionsService } from '../positions/positions.service';
import { RedisService } from '../../common/redis/redis.service';
import { Decimal } from '@prisma/client/runtime/library';
import { TransactionType } from '@prisma/client';

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
    const [positions, realizedGains, rawPrices, txGroups] = await Promise.all([
      this.positionsService.findByUser(userId),
      this.prisma.realizedGain.findMany({ where: { userId } }),
      this.redis.hgetall('market:prices'),
      (this.prisma.transaction as any).groupBy({
        by: ['symbol'],
        where: { userId },
        _sum: { fees: true },
        _min: { createdAt: true },
      }) as Promise<{ symbol: string; _sum: { fees: Decimal | null }; _min: { createdAt: Date | null } }[]>,
    ]);

    const feesBySymbol: Record<string, string> = {};
    const firstBuyBySymbol: Record<string, Date> = {};
    for (const g of txGroups) {
      feesBySymbol[g.symbol] = g._sum.fees?.toString() ?? '0';
      if (g._min.createdAt) firstBuyBySymbol[g.symbol] = g._min.createdAt;
    }

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
    let totalPortfolioValue = new Decimal(0);

    type PosData = {
      symbol: string; totalQuantity: string; averagePrice: string; totalInvested: string;
      currentPrice: number | null; lastPriceUpdate: string | null;
      unrealizedPnL: string | null; unrealizedRaw: Decimal | null;
      realizedPnL: string; graphData: { price: string; timestamp: Date }[];
      returnPercent: number | null; marketValue: Decimal;
      daysSinceFirstBuy: number | null; totalFeesPaid: string;
      breakEvenPrice: string; portfolioContributionPct: string;
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
      const marketValue = currPx ? currPx.mul(qty) : invested;

      const firstBuy = firstBuyBySymbol[pos.symbol];
      const daysSinceFirstBuy = firstBuy
        ? Math.floor((Date.now() - firstBuy.getTime()) / 86400000)
        : null;

      totalInvested = totalInvested.add(invested);
      if (unrealizedRaw) totalUnrealized = totalUnrealized.add(unrealizedRaw);
      totalRealized = totalRealized.add(realized);
      totalPortfolioValue = totalPortfolioValue.add(marketValue);

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
        marketValue,
        daysSinceFirstBuy,
        totalFeesPaid: new Decimal(feesBySymbol[pos.symbol] ?? '0').toFixed(2),
        breakEvenPrice: avgPx.toFixed(2),
        portfolioContributionPct: '0',
      };
    });

    // compute portfolioContributionPct now that totalPortfolioValue is known
    for (const p of positionData) {
      p.portfolioContributionPct = totalPortfolioValue.isZero()
        ? '0.00'
        : p.marketValue.div(totalPortfolioValue).mul(100).toFixed(2);
    }

    const withUnrealized = positionData.filter((p) => p.unrealizedRaw != null);
    const best = withUnrealized.length
      ? withUnrealized.reduce((a, b) => (a.unrealizedRaw!.gt(b.unrealizedRaw!) ? a : b))
      : null;
    const worst = withUnrealized.length
      ? withUnrealized.reduce((a, b) => (a.unrealizedRaw!.lt(b.unrealizedRaw!) ? a : b))
      : null;

    const closedPositions = realizedGains.length;
    const winners = realizedGains.filter((g) => new Decimal(g.profit.toString()).gt(0)).length;
    const winRate = closedPositions > 0 ? ((winners / closedPositions) * 100).toFixed(1) : null;

    const totalPnL = totalRealized.add(totalUnrealized);
    const totalPortfolioReturn = totalInvested.isZero()
      ? null
      : totalPnL.div(totalInvested).mul(100).toFixed(2);

    const cleanPositions = positionData.map(({ unrealizedRaw: _r, marketValue: _mv, returnPercent: _rp, ...rest }) => rest);

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

  // ── Transaction Detail (Feature 1) ────────────────────────────────────────

  async getTransactionDetail(userId: string, txId: string) {
    const tx = await this.prisma.transaction.findFirst({ where: { id: txId, userId } });
    if (!tx) throw new NotFoundException('Transaction not found');

    const [priceAtTradeRow, allSymbolTxns, position, realizedGains, rawPrices] = await Promise.all([
      this.prisma.stockPriceHistory.findFirst({
        where: { symbol: tx.symbol, timestamp: { lte: tx.createdAt } },
        orderBy: { timestamp: 'desc' },
        select: { price: true, timestamp: true },
      }),
      this.prisma.transaction.findMany({
        where: { userId, symbol: tx.symbol },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.position.findUnique({ where: { userId_symbol: { userId, symbol: tx.symbol } } }),
      this.prisma.realizedGain.findMany({ where: { userId, symbol: tx.symbol } }),
      this.redis.hgetall('market:prices'),
    ]);

    const { price: currentPrice } = this.parseLivePriceFull(rawPrices, tx.symbol);

    // costBasis.beforeTrade: replay BUYs before this tx
    let prevQty = new Decimal(0), prevInv = new Decimal(0);
    for (const t of allSymbolTxns) {
      if (t.id === tx.id) break;
      if (t.type === TransactionType.BUY) {
        const cost = new Decimal(t.quantity.toString()).mul(t.price.toString()).add((t as any).fees?.toString() ?? '0');
        prevQty = prevQty.add(t.quantity.toString());
        prevInv = prevInv.add(cost);
      } else {
        prevQty = prevQty.sub(t.quantity.toString());
        if (!prevQty.isZero()) prevInv = prevQty.mul(prevInv.isZero() ? new Decimal(0) : prevInv.div(prevQty.add(t.quantity.toString())));
        else prevInv = new Decimal(0);
      }
    }

    const qty = new Decimal(tx.quantity.toString());
    const px = new Decimal(tx.price.toString());
    const fees = new Decimal((tx as any).fees?.toString() ?? '0');
    const tradeTotal = qty.mul(px);

    // totalFees for symbol
    const allFeesAgg = await (this.prisma.transaction as any).aggregate({
      where: { userId, symbol: tx.symbol },
      _sum: { fees: true },
    });
    const totalFeesForSymbol = new Decimal(allFeesAgg._sum.fees?.toString() ?? '0').toFixed(2);

    // realizedImpact for SELL
    let realizedImpact: null | { profit: string; avgPriceAtSell: string; sellPrice: string; returnPercent: string } = null;
    if (tx.type === TransactionType.SELL) {
      const matched = realizedGains.find(
        (g) => new Decimal(g.quantity.toString()).eq(qty) &&
               new Decimal(g.sellPrice.toString()).eq(px) &&
               Math.abs(g.createdAt.getTime() - tx.createdAt.getTime()) < 10000,
      );
      if (matched) {
        const entryPx = new Decimal(matched.avgPrice.toString());
        const retPct = px.sub(entryPx).div(entryPx).mul(100);
        realizedImpact = {
          profit: new Decimal(matched.profit.toString()).toFixed(2),
          avgPriceAtSell: entryPx.toFixed(2),
          sellPrice: px.toFixed(2),
          returnPercent: retPct.toFixed(2),
        };
      }
    }

    const priceAtTrade = priceAtTradeRow ? parseFloat(priceAtTradeRow.price.toString()) : null;
    const priceChangeSince = priceAtTrade != null && currentPrice != null
      ? (((currentPrice - priceAtTrade) / priceAtTrade) * 100).toFixed(2)
      : null;

    return {
      transaction: {
        id: tx.id, symbol: tx.symbol, type: tx.type,
        quantity: qty.toString(), price: px.toFixed(2),
        fees: fees.toFixed(2), total: tradeTotal.toFixed(2),
        createdAt: tx.createdAt,
      },
      priceContext: {
        priceAtTrade,
        priceAtTradeTime: priceAtTradeRow?.timestamp ?? null,
        currentPrice,
        priceChangeSinceTrade: priceChangeSince,
      },
      costBasis: {
        beforeTrade: prevQty.isZero() ? null : {
          avgPrice: prevInv.isZero() ? '0.00' : prevInv.div(prevQty).toFixed(2),
          totalQuantity: prevQty.toString(),
          totalInvested: prevInv.toFixed(2),
        },
        afterTrade: position ? {
          avgPrice: new Decimal(position.averagePrice.toString()).toFixed(2),
          totalQuantity: position.totalQuantity.toString(),
          totalInvested: new Decimal(position.totalInvested.toString()).toFixed(2),
        } : null,
      },
      feeImpact: {
        feesThisTrade: fees.toFixed(2),
        totalFeesForSymbol,
        feeAsPercentOfTrade: tradeTotal.isZero() ? '0.00' : fees.div(tradeTotal).mul(100).toFixed(4),
      },
      symbolTimeline: allSymbolTxns.map((t) => ({
        id: t.id, type: t.type,
        quantity: t.quantity.toString(),
        price: new Decimal(t.price.toString()).toFixed(2),
        fees: new Decimal((t as any).fees?.toString() ?? '0').toFixed(2),
        total: new Decimal(t.quantity.toString()).mul(t.price.toString()).toFixed(2),
        createdAt: t.createdAt,
        isCurrentTrade: t.id === tx.id,
      })),
      realizedImpact,
    };
  }

  // ── Position Detail (Feature 2) ───────────────────────────────────────────

  async getPositionDetail(userId: string, symbol: string) {
    const [position, txns, realizedGains, priceHistory, rawPrices] = await Promise.all([
      this.prisma.position.findUnique({ where: { userId_symbol: { userId, symbol } } }),
      this.prisma.transaction.findMany({ where: { userId, symbol }, orderBy: { createdAt: 'asc' } }),
      this.prisma.realizedGain.findMany({ where: { userId, symbol }, orderBy: { createdAt: 'asc' } }),
      this.prisma.stockPriceHistory.findMany({
        where: { symbol },
        orderBy: { timestamp: 'asc' },
        select: { price: true, timestamp: true },
        take: 500,
      }),
      this.redis.hgetall('market:prices'),
    ]);

    if (!position) throw new NotFoundException(`No position found for ${symbol}`);

    const { price: currentPrice } = this.parseLivePriceFull(rawPrices, symbol);
    const avgPx = new Decimal(position.averagePrice.toString());
    const qty = new Decimal(position.totalQuantity.toString());
    const invested = new Decimal(position.totalInvested.toString());

    const breakEvenPrice = avgPx.toFixed(2);
    const gapToBreakEven = currentPrice != null
      ? ((currentPrice - avgPx.toNumber()) / avgPx.toNumber() * 100).toFixed(2)
      : null;
    const unrealizedPnL = currentPrice != null
      ? new Decimal(currentPrice).sub(avgPx).mul(qty).toFixed(2)
      : null;
    const unrealizedPct = currentPrice != null && !invested.isZero()
      ? new Decimal(currentPrice).sub(avgPx).mul(qty).div(invested).mul(100).toFixed(2)
      : null;

    // days held = days since first BUY
    const firstBuy = txns.find((t) => t.type === TransactionType.BUY);
    const daysHeld = firstBuy
      ? Math.floor((Date.now() - firstBuy.createdAt.getTime()) / 86400000)
      : null;

    // total fees
    const totalFeesPaid = txns.reduce(
      (sum, t) => sum.add((t as any).fees?.toString() ?? '0'), new Decimal(0),
    ).toFixed(2);

    // cost basis ladder
    const totalQtyBought = txns
      .filter((t) => t.type === TransactionType.BUY)
      .reduce((s, t) => s.add(t.quantity.toString()), new Decimal(0));
    const heldFraction = totalQtyBought.isZero() ? new Decimal(0) : qty.div(totalQtyBought);

    const costBasisLadder = txns
      .filter((t) => t.type === TransactionType.BUY)
      .map((t) => {
        const buyPx = parseFloat(t.price.toString());
        const lotQty = new Decimal(t.quantity.toString()).mul(heldFraction);
        return {
          date: t.createdAt.toISOString(),
          quantity: lotQty.toFixed(4),
          buyPrice: buyPx.toFixed(2),
          lotValue: lotQty.mul(buyPx).toFixed(2),
          isAboveBreakEven: currentPrice != null ? buyPx < currentPrice : false,
        };
      });

    // allTransactions with running cumulative
    let cumQty = new Decimal(0);
    let cumInv = new Decimal(0);
    const allTransactions = txns.map((t) => {
      const tQty = new Decimal(t.quantity.toString());
      const tPx = new Decimal(t.price.toString());
      const tFees = new Decimal((t as any).fees?.toString() ?? '0');
      if (t.type === TransactionType.BUY) {
        const cost = tQty.mul(tPx).add(tFees);
        cumQty = cumQty.add(tQty);
        cumInv = cumInv.add(cost);
      } else {
        cumQty = cumQty.sub(tQty);
        if (cumQty.isZero()) cumInv = new Decimal(0);
        else cumInv = cumQty.mul(cumInv.div(cumQty.add(tQty)));
      }
      return {
        id: t.id, type: t.type,
        quantity: t.quantity.toString(),
        price: tPx.toFixed(2),
        fees: tFees.toFixed(2),
        total: tQty.mul(tPx).toFixed(2),
        createdAt: t.createdAt,
        cumulativeQty: cumQty.toFixed(4),
        cumulativeAvgPrice: cumQty.isZero() ? '0.00' : cumInv.div(cumQty).toFixed(2),
      };
    });

    return {
      position: {
        symbol,
        totalQuantity: qty.toString(),
        averagePrice: avgPx.toFixed(2),
        totalInvested: invested.toFixed(2),
      },
      currentPrice,
      breakEvenPrice,
      gapToBreakEven,
      unrealizedPnL,
      unrealizedPct,
      daysHeld,
      totalFeesPaid,
      costBasisLadder,
      priceHistory: priceHistory.map((h) => ({
        price: parseFloat(h.price.toString()),
        timestamp: h.timestamp.toISOString(),
      })),
      allTransactions,
      realizedGains: realizedGains.map((g) => ({
        quantity: g.quantity.toString(),
        sellPrice: new Decimal(g.sellPrice.toString()).toFixed(2),
        avgPrice: new Decimal(g.avgPrice.toString()).toFixed(2),
        profit: new Decimal(g.profit.toString()).toFixed(2),
        fees: new Decimal(g.fees.toString()).toFixed(2),
        createdAt: g.createdAt,
      })),
    };
  }

  // ── Transactions Master (Feature 3) ───────────────────────────────────────

  async getTransactionsMaster(
    userId: string,
    filters: { symbol?: string; type?: string; from?: string; to?: string },
  ) {
    const where: any = { userId };
    if (filters.symbol) where.symbol = filters.symbol.toUpperCase();
    if (filters.type) where.type = filters.type.toUpperCase();
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from);
      if (filters.to) where.createdAt.lte = new Date(filters.to);
    }

    const [txns, realizedGains] = await Promise.all([
      this.prisma.transaction.findMany({ where, orderBy: { createdAt: 'asc' } }),
      this.prisma.realizedGain.findMany({ where: { userId } }),
    ]);

    let runningBalance = new Decimal(0);
    let feesCumulative = new Decimal(0);
    let totalFees = new Decimal(0);
    let totalRealizedPnL = new Decimal(0);
    let totalBuys = 0, totalSells = 0;

    for (const g of realizedGains) totalRealizedPnL = totalRealizedPnL.add(g.profit.toString());

    const rows = txns.map((t) => {
      const qty = new Decimal(t.quantity.toString());
      const px = new Decimal(t.price.toString());
      const fees = new Decimal((t as any).fees?.toString() ?? '0');
      const total = qty.mul(px);

      feesCumulative = feesCumulative.add(fees);
      totalFees = totalFees.add(fees);

      let pnlOnSell: string | null = null;
      if (t.type === TransactionType.BUY) {
        runningBalance = runningBalance.sub(total).sub(fees);
        totalBuys++;
      } else {
        runningBalance = runningBalance.add(total).sub(fees);
        totalSells++;
        const matched = realizedGains.find(
          (g) => g.symbol === t.symbol &&
                 new Decimal(g.quantity.toString()).eq(qty) &&
                 new Decimal(g.sellPrice.toString()).eq(px) &&
                 Math.abs(g.createdAt.getTime() - t.createdAt.getTime()) < 10000,
        );
        if (matched) pnlOnSell = new Decimal(matched.profit.toString()).toFixed(2);
      }

      return {
        id: t.id, symbol: t.symbol, type: t.type,
        quantity: qty.toString(),
        price: px.toFixed(2),
        fees: fees.toFixed(2),
        total: total.toFixed(2),
        createdAt: t.createdAt,
        runningBalance: runningBalance.toFixed(2),
        feesCumulative: feesCumulative.toFixed(2),
        pnlOnSell,
      };
    });

    return {
      transactions: rows,
      summary: {
        totalTrades: txns.length,
        totalBuys,
        totalSells,
        totalFees: totalFees.toFixed(2),
        totalRealizedPnL: totalRealizedPnL.toFixed(2),
      },
    };
  }

  // ── Risk Analytics (Feature 4) ────────────────────────────────────────────

  async getRiskAnalytics(userId: string) {
    const [positions, rawPrices, stocksData] = await Promise.all([
      this.positionsService.findByUser(userId),
      this.redis.hgetall('market:prices'),
      this.prisma.stock.findMany({ select: { symbol: true, sector: true } }),
    ]);

    const sectorMap: Record<string, string> = {};
    for (const s of stocksData) sectorMap[s.symbol] = s.sector ?? 'Unknown';

    let totalPortfolioValue = new Decimal(0);
    const items = positions.map((pos) => {
      const qty = new Decimal(pos.totalQuantity.toString());
      const avgPx = new Decimal(pos.averagePrice.toString());
      const currPx = this.parseLivePrice(rawPrices, pos.symbol);
      const effectivePx = currPx ?? avgPx;
      const value = qty.mul(effectivePx);
      const unrealizedPnL = currPx ? currPx.sub(avgPx).mul(qty) : new Decimal(0);
      totalPortfolioValue = totalPortfolioValue.add(value);
      return {
        symbol: pos.symbol,
        value,
        qty,
        avgPx,
        currPx,
        unrealizedPnL,
        invested: new Decimal(pos.totalInvested.toString()),
      };
    });

    // HHI & concentration
    const weights = items.map((i) =>
      totalPortfolioValue.isZero() ? new Decimal(0) : i.value.div(totalPortfolioValue).mul(100),
    );
    const hhi = weights.reduce((sum, w) => sum.add(w.pow(2)), new Decimal(0));
    const diversificationScore = Math.max(0, Math.min(100, 100 - hhi.div(100).toNumber()));

    const sorted = [...items].sort((a, b) => b.value.sub(a.value).toNumber());
    const top3 = sorted.slice(0, 3);
    const top3Value = top3.reduce((s, i) => s.add(i.value), new Decimal(0));
    const top3Percent = totalPortfolioValue.isZero()
      ? '0.00'
      : top3Value.div(totalPortfolioValue).mul(100).toFixed(2);

    // sector risk
    const sectorValues: Record<string, Decimal> = {};
    for (const item of items) {
      const sector = sectorMap[item.symbol] ?? 'Unknown';
      sectorValues[sector] = (sectorValues[sector] ?? new Decimal(0)).add(item.value);
    }
    const sectorRisk = Object.entries(sectorValues).map(([sector, value]) => {
      const pct = totalPortfolioValue.isZero() ? new Decimal(0) : value.div(totalPortfolioValue).mul(100);
      return {
        sector,
        value: value.toFixed(2),
        percent: pct.toFixed(2),
        hhi_contribution: pct.pow(2).toFixed(2),
      };
    }).sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

    // max drawdown from timeline (90 days)
    const from90 = new Date(Date.now() - 90 * 86400000);
    const timelineData = await this.getTimeline(userId, from90, new Date());
    let drawdown = { maxDrawdownPct: '0.00', maxDrawdownAbs: '0.00', drawdownPeriod: null as null | { from: string; to: string } };
    if ((timelineData as any).timeline?.length > 1) {
      const tl: { timestamp: string; totalValue: string }[] = (timelineData as any).timeline;
      let peak = parseFloat(tl[0].totalValue);
      let peakDate = tl[0].timestamp;
      let maxDD = 0, maxDDAbs = 0, troughDate = tl[0].timestamp;
      for (const pt of tl) {
        const val = parseFloat(pt.totalValue);
        if (val > peak) { peak = val; peakDate = pt.timestamp; }
        const dd = peak > 0 ? (val - peak) / peak * 100 : 0;
        if (dd < maxDD) { maxDD = dd; maxDDAbs = val - peak; troughDate = pt.timestamp; }
      }
      drawdown = {
        maxDrawdownPct: maxDD.toFixed(2),
        maxDrawdownAbs: maxDDAbs.toFixed(2),
        drawdownPeriod: maxDD < 0 ? { from: peakDate, to: troughDate } : null,
      };
    }

    return {
      concentrationRisk: {
        top3Holdings: top3.map((i) => ({
          symbol: i.symbol,
          value: i.value.toFixed(2),
          percent: totalPortfolioValue.isZero() ? '0.00' : i.value.div(totalPortfolioValue).mul(100).toFixed(2),
        })),
        top3Percent,
        hhi: hhi.toFixed(0),
        diversificationScore: diversificationScore.toFixed(1),
      },
      positionRisk: items.map((i) => ({
        symbol: i.symbol,
        portfolioPercent: totalPortfolioValue.isZero() ? '0.00' : i.value.div(totalPortfolioValue).mul(100).toFixed(2),
        marketValue: i.value.toFixed(2),
        capitalAtRisk: i.value.toFixed(2),
        unrealizedPnL: i.unrealizedPnL.toFixed(2),
        unrealizedPct: i.invested.isZero() ? '0.00' : i.unrealizedPnL.div(i.invested).mul(100).toFixed(2),
      })),
      drawdown,
      sectorRisk,
    };
  }

  // ── P&L Calendar (Feature 5) ──────────────────────────────────────────────

  async getPnLCalendar(userId: string, year: number) {
    const rows = await this.prisma.$queryRaw<{ date: Date; pnl: string; trades: bigint }[]>`
      SELECT DATE_TRUNC('day', created_at) AS date,
             SUM(profit)::text             AS pnl,
             COUNT(*)                      AS trades
      FROM   realized_gains
      WHERE  user_id = ${userId}
        AND  EXTRACT(YEAR FROM created_at) = ${year}
      GROUP  BY 1
      ORDER  BY 1
    `;
    return {
      dailyPnL: rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        realizedPnL: parseFloat(r.pnl),
        tradeCount: Number(r.trades),
      })),
    };
  }

  // ── Closed Trade Scoring (Feature 8) ─────────────────────────────────────

  async getClosedTrades(userId: string) {
    const gains = await this.prisma.realizedGain.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    let totalHoldDays = 0, holdCount = 0;
    let totalAnnualized = new Decimal(0), annualizedCount = 0;

    const trades = await Promise.all(
      gains.map(async (g) => {
        const qty = new Decimal(g.quantity.toString());
        const sellPx = new Decimal(g.sellPrice.toString());
        const avgPx = new Decimal(g.avgPrice.toString());
        const profit = new Decimal(g.profit.toString());

        const returnPct = avgPx.isZero() ? new Decimal(0) : sellPx.sub(avgPx).div(avgPx).mul(100);

        // find matching BUY
        const buyTx = await this.prisma.transaction.findFirst({
          where: { userId, symbol: g.symbol, type: TransactionType.BUY, createdAt: { lt: g.createdAt } },
          orderBy: { createdAt: 'desc' },
        });

        let holdDays: number | null = null;
        let annualizedReturn: string | null = null;
        if (buyTx) {
          holdDays = Math.max(1, Math.floor((g.createdAt.getTime() - buyTx.createdAt.getTime()) / 86400000));
          totalHoldDays += holdDays;
          holdCount++;
          const ann = returnPct.div(100).mul(365).div(holdDays).mul(100);
          annualizedReturn = ann.toFixed(2);
          totalAnnualized = totalAnnualized.add(ann);
          annualizedCount++;
        }

        const rPct = returnPct.toNumber();
        const aPct = annualizedReturn ? parseFloat(annualizedReturn) : 0;
        let grade: 'A' | 'B' | 'C' | 'D';
        if (rPct >= 15 || aPct >= 50) grade = 'A';
        else if (rPct >= 5 || aPct >= 20) grade = 'B';
        else if (rPct >= 0) grade = 'C';
        else grade = 'D';
        grades[grade]++;

        return {
          id: g.id,
          symbol: g.symbol,
          quantity: qty.toString(),
          entryPrice: avgPx.toFixed(2),
          exitPrice: sellPx.toFixed(2),
          profit: profit.toFixed(2),
          fees: new Decimal(g.fees.toString()).toFixed(2),
          sellDate: g.createdAt.toISOString(),
          buyDate: buyTx?.createdAt.toISOString() ?? null,
          holdDays,
          annualizedReturn,
          returnPct: returnPct.toFixed(2),
          grade,
        };
      }),
    );

    return {
      trades,
      summary: {
        totalTrades: trades.length,
        avgHoldDays: holdCount > 0 ? Math.round(totalHoldDays / holdCount) : null,
        avgAnnualizedReturn: annualizedCount > 0 ? totalAnnualized.div(annualizedCount).toFixed(2) : null,
        gradeDistribution: grades,
      },
    };
  }

  // ── Smart Insights (Feature 9) ────────────────────────────────────────────

  async getInsights(userId: string) {
    const analytics = await this.getAnalytics(userId);
    const insights: { type: string; icon: string; message: string; symbol?: string; priority: number }[] = [];

    const totalInv = parseFloat(analytics.portfolioValue.totalInvested);
    let totalFees = new Decimal(0);

    for (const pos of analytics.positions as any[]) {
      const avgPx = parseFloat(pos.averagePrice);
      const currPx = pos.currentPrice;
      const gap = currPx != null ? ((currPx - avgPx) / avgPx * 100) : null;

      if (gap !== null && gap < -2) {
        insights.push({
          type: 'WARNING', icon: 'trending-down',
          message: `${pos.symbol} is ${Math.abs(gap).toFixed(1)}% below break-even (avg ${pos.averagePrice} EGP)`,
          symbol: pos.symbol, priority: 1,
        });
      }

      if (pos.daysSinceFirstBuy != null && pos.daysSinceFirstBuy > 30) {
        insights.push({
          type: 'INFO', icon: 'clock',
          message: `You've held ${pos.symbol} for ${pos.daysSinceFirstBuy} days (since avg cost ${pos.averagePrice} EGP)`,
          symbol: pos.symbol, priority: 3,
        });
      }

      if (pos.totalFeesPaid) totalFees = totalFees.add(pos.totalFeesPaid);
    }

    // concentration warning
    const positions = (analytics.positions as any[]);
    if (positions.length >= 3) {
      const rawPrices = await this.redis.hgetall('market:prices');
      let totalVal = new Decimal(0);
      const vals = positions.map((p) => {
        const px = this.parseLivePrice(rawPrices, p.symbol) ?? new Decimal(p.averagePrice);
        const v = new Decimal(p.totalQuantity).mul(px);
        totalVal = totalVal.add(v);
        return { symbol: p.symbol, v };
      });
      const sorted = vals.sort((a, b) => b.v.sub(a.v).toNumber());
      const top3Pct = totalVal.isZero() ? 0 :
        sorted.slice(0, 3).reduce((s, i) => s.add(i.v), new Decimal(0)).div(totalVal).mul(100).toNumber();
      if (top3Pct > 60) {
        insights.push({
          type: 'WARNING', icon: 'concentration',
          message: `Top 3 holdings = ${top3Pct.toFixed(1)}% of portfolio — consider diversifying`,
          priority: 2,
        });
      }
    }

    // fee warning
    if (totalInv > 0 && totalFees.toNumber() / totalInv * 100 > 1) {
      insights.push({
        type: 'WARNING', icon: 'fee',
        message: `Fees have consumed ${(totalFees.toNumber() / totalInv * 100).toFixed(2)}% of invested capital`,
        priority: 2,
      });
    }

    // all profitable
    const allProfitable = positions.every((p: any) => p.currentPrice != null && parseFloat(p.currentPrice) > parseFloat(p.averagePrice));
    if (positions.length > 0 && allProfitable) {
      insights.push({
        type: 'SUCCESS', icon: 'trending-up',
        message: `All ${positions.length} positions are currently above break-even`,
        priority: 5,
      });
    }

    return { insights: insights.sort((a, b) => a.priority - b.priority) };
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
        id: t.id, type: t.type,
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
