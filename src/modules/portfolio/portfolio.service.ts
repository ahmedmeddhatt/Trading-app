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

  private parseLivePrice(
    rawPrices: Record<string, string>,
    symbol: string,
  ): Decimal | null {
    try {
      const parsed = rawPrices?.[symbol] ? JSON.parse(rawPrices[symbol]) : null;
      return parsed?.price != null ? new Decimal(parsed.price) : null;
    } catch {
      return null;
    }
  }

  private parseLivePriceFull(
    rawPrices: Record<string, string>,
    symbol: string,
  ) {
    try {
      const parsed = rawPrices?.[symbol] ? JSON.parse(rawPrices[symbol]) : null;
      return {
        price: parsed?.price ?? null,
        lastPriceUpdate: parsed?.timestamp ?? null,
      };
    } catch {
      return { price: null, lastPriceUpdate: null };
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

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

  // ── Analytics (enhanced) ──────────────────────────────────────────────────

  async getAnalytics(userId: string, fromDate?: Date, toDate?: Date) {
    const dateFilter =
      fromDate || toDate
        ? {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          }
        : undefined;

    const [positions, realizedGains, rawPrices, txGroups, allTransactions] =
      await Promise.all([
        this.positionsService.findByUser(userId),
        this.prisma.realizedGain.findMany({
          where: {
            userId,
            deletedAt: null,
            ...(dateFilter ? { createdAt: dateFilter } : {}),
          },
        }),
        this.redis.hgetall('market:prices'),
        (this.prisma.transaction as any).groupBy({
          by: ['symbol'],
          where: { userId, ...(dateFilter ? { createdAt: dateFilter } : {}) },
          _sum: { fees: true },
          _min: { createdAt: true },
        }) as Promise<
          {
            symbol: string;
            _sum: { fees: Decimal | null };
            _min: { createdAt: Date | null };
          }[]
        >,
        this.prisma.transaction.findMany({
          where: { userId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: {
            symbol: true,
            type: true,
            quantity: true,
            price: true,
            fees: true,
            createdAt: true,
          },
        }),
      ]);

    const feesBySymbol: Record<string, string> = {};
    const firstBuyBySymbol: Record<string, Date> = {};
    for (const g of txGroups) {
      feesBySymbol[g.symbol] = g._sum.fees?.toString() ?? '0';
      if (g._min.createdAt) firstBuyBySymbol[g.symbol] = g._min.createdAt;
    }

    const realizedBySymbol: Record<string, Decimal> = {};
    for (const g of realizedGains) {
      realizedBySymbol[g.symbol] = (
        realizedBySymbol[g.symbol] ?? new Decimal(0)
      ).add(g.profit);
    }

    // Collect ALL symbols that ever had transactions (for historical reconstruction)
    const allSymbols = [...new Set(allTransactions.map((t) => t.symbol))];
    const symbols = positions.map((p) => p.symbol);
    const historySymbols =
      allSymbols.length > symbols.length ? allSymbols : symbols;
    const history = historySymbols.length
      ? await this.prisma.stockPriceHistory.findMany({
          where: {
            symbol: { in: historySymbols },
          },
          orderBy: { timestamp: 'asc' },
          select: { symbol: true, price: true, timestamp: true },
        })
      : [];

    const historyBySymbol: Record<
      string,
      { price: string; timestamp: Date }[]
    > = {};
    for (const h of history) {
      (historyBySymbol[h.symbol] ??= []).push({
        price: h.price.toString(),
        timestamp: h.timestamp,
      });
    }

    let totalInvested = new Decimal(0);
    let totalUnrealized = new Decimal(0);
    let totalPortfolioValue = new Decimal(0);

    // Compute totalRealized from ALL realizedGains — not just for positions still in DB
    const totalRealized = realizedGains.reduce(
      (sum, g) => sum.add(new Decimal(g.profit.toString())),
      new Decimal(0),
    );

    type PosData = {
      symbol: string;
      totalQuantity: string;
      averagePrice: string;
      totalInvested: string;
      currentPrice: number | null;
      lastPriceUpdate: string | null;
      unrealizedPnL: string | null;
      unrealizedRaw: Decimal | null;
      realizedPnL: string;
      graphData: { price: string; timestamp: Date }[];
      returnPercent: number | null;
      marketValue: Decimal;
      daysSinceFirstBuy: number | null;
      totalFeesPaid: string;
      breakEvenPrice: string;
      portfolioContributionPct: string;
    };

    // Only include positions with a meaningful quantity (exclude fully sold)
    const activePositions = positions.filter((p) =>
      new Decimal(p.totalQuantity.toString()).gt(0),
    );

    const positionData: PosData[] = activePositions.map((pos) => {
      const qty = new Decimal(pos.totalQuantity.toString());
      const avgPx = new Decimal(pos.averagePrice.toString());
      const invested = new Decimal(pos.totalInvested.toString());
      const { price, lastPriceUpdate } = this.parseLivePriceFull(
        rawPrices,
        pos.symbol,
      );
      const currPx = price != null ? new Decimal(price) : null;
      const unrealizedRaw = currPx ? currPx.sub(avgPx).mul(qty) : null;
      const realized = realizedBySymbol[pos.symbol] ?? new Decimal(0);
      const returnPercent =
        invested.isZero() || !unrealizedRaw
          ? null
          : unrealizedRaw.div(invested).mul(100).toNumber();
      const marketValue = currPx ? currPx.mul(qty) : invested;

      const firstBuy = firstBuyBySymbol[pos.symbol];
      const daysSinceFirstBuy = firstBuy
        ? Math.floor((Date.now() - firstBuy.getTime()) / 86400000)
        : null;

      totalInvested = totalInvested.add(invested);
      if (unrealizedRaw) totalUnrealized = totalUnrealized.add(unrealizedRaw);
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
    let best = withUnrealized.length
      ? withUnrealized.reduce((a, b) =>
          a.unrealizedRaw!.gt(b.unrealizedRaw!) ? a : b,
        )
      : null;
    let worst = withUnrealized.length
      ? withUnrealized.reduce((a, b) =>
          a.unrealizedRaw!.lt(b.unrealizedRaw!) ? a : b,
        )
      : null;

    // If only one position, show it in the relevant card only
    if (best && worst && best.symbol === worst.symbol) {
      if (best.unrealizedRaw!.gte(0)) {
        worst = null;
      } else {
        best = null;
      }
    }

    // Win rate = total realized profit / total capital ever invested from account start
    const closedCostBasis = realizedGains.reduce(
      (sum, g) =>
        sum.add(
          new Decimal(g.quantity.toString()).mul(
            new Decimal(g.avgPrice.toString()),
          ),
        ),
      new Decimal(0),
    );
    const totalEverInvested = totalInvested.add(closedCostBasis);
    const winRate = totalEverInvested.gt(0)
      ? totalRealized.div(totalEverInvested).mul(100).toFixed(1)
      : null;

    const totalPnL = totalRealized.add(totalUnrealized);
    const totalPortfolioReturn = totalInvested.isZero()
      ? null
      : totalPnL.div(totalInvested).mul(100).toFixed(2);

    const cleanPositions = positionData.map(
      ({ unrealizedRaw: _r, marketValue: _mv, returnPercent: _rp, ...rest }) =>
        rest,
    );

    return {
      positions: cleanPositions,
      portfolioValue: {
        totalInvested: totalInvested.toFixed(2),
        totalRealized: totalRealized.toFixed(2),
        totalUnrealized: totalUnrealized.toFixed(2),
        totalPnL: totalPnL.toFixed(2),
        totalPortfolioReturn: totalPortfolioReturn
          ? `${totalPortfolioReturn}%`
          : null,
      },
      bestPerformer: best
        ? {
            symbol: best.symbol,
            unrealizedPnL: best.unrealizedPnL,
            returnPercent: best.returnPercent,
          }
        : null,
      worstPerformer: worst
        ? {
            symbol: worst.symbol,
            unrealizedPnL: worst.unrealizedPnL,
            returnPercent: worst.returnPercent,
          }
        : null,
      winRate: winRate ? `${winRate}%` : null,
      // All transactions for client-side position reconstruction
      transactions: allTransactions.map((t) => ({
        symbol: t.symbol,
        type: t.type,
        quantity: t.quantity.toString(),
        price: t.price.toString(),
        fees: t.fees.toString(),
        date: t.createdAt.toISOString(),
      })),
      // All price history for historical price lookups
      priceHistory: Object.fromEntries(
        Object.entries(
          history.reduce(
            (acc, h) => {
              (acc[h.symbol] ??= []).push({
                price: h.price.toString(),
                timestamp: h.timestamp.toISOString(),
              });
              return acc;
            },
            {} as Record<string, { price: string; timestamp: string }[]>,
          ),
        ),
      ),
    };
  }

  // ── Transaction Detail (Feature 1) ────────────────────────────────────────

  async getTransactionDetail(userId: string, txId: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: txId, userId, deletedAt: null },
    });
    if (!tx) throw new NotFoundException('Transaction not found');

    const [priceAtTradeRow, allSymbolTxns, position, realizedGains, rawPrices] =
      await Promise.all([
        this.prisma.stockPriceHistory.findFirst({
          where: { symbol: tx.symbol, timestamp: { lte: tx.createdAt } },
          orderBy: { timestamp: 'desc' },
          select: { price: true, timestamp: true },
        }),
        this.prisma.transaction.findMany({
          where: { userId, symbol: tx.symbol, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.position.findFirst({
          where: { userId, symbol: tx.symbol, deletedAt: null },
        }),
        this.prisma.realizedGain.findMany({
          where: { userId, symbol: tx.symbol, deletedAt: null },
        }),
        this.redis.hgetall('market:prices'),
      ]);

    const { price: currentPrice } = this.parseLivePriceFull(
      rawPrices,
      tx.symbol,
    );

    // costBasis.beforeTrade: replay BUYs before this tx
    let prevQty = new Decimal(0),
      prevInv = new Decimal(0);
    for (const t of allSymbolTxns) {
      if (t.id === tx.id) break;
      if (t.type === TransactionType.BUY) {
        const cost = new Decimal(t.quantity.toString())
          .mul(t.price.toString())
          .add((t as any).fees?.toString() ?? '0');
        prevQty = prevQty.add(t.quantity.toString());
        prevInv = prevInv.add(cost);
      } else {
        prevQty = prevQty.sub(t.quantity.toString());
        if (!prevQty.isZero())
          prevInv = prevQty.mul(
            prevInv.isZero()
              ? new Decimal(0)
              : prevInv.div(prevQty.add(t.quantity.toString())),
          );
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
    const totalFeesForSymbol = new Decimal(
      allFeesAgg._sum.fees?.toString() ?? '0',
    ).toFixed(2);

    // realizedImpact for SELL
    let realizedImpact: null | {
      profit: string;
      avgPriceAtSell: string;
      sellPrice: string;
      returnPercent: string;
    } = null;
    if (tx.type === TransactionType.SELL) {
      const matched = realizedGains.find(
        (g) =>
          new Decimal(g.quantity.toString()).eq(qty) &&
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

    const priceAtTrade = priceAtTradeRow
      ? parseFloat(priceAtTradeRow.price.toString())
      : null;
    const priceChangeSince =
      priceAtTrade != null && currentPrice != null
        ? (((currentPrice - priceAtTrade) / priceAtTrade) * 100).toFixed(2)
        : null;

    return {
      transaction: {
        id: tx.id,
        symbol: tx.symbol,
        type: tx.type,
        quantity: qty.toString(),
        price: px.toFixed(2),
        fees: fees.toFixed(2),
        total: tradeTotal.toFixed(2),
        createdAt: tx.createdAt,
      },
      priceContext: {
        priceAtTrade,
        priceAtTradeTime: priceAtTradeRow?.timestamp ?? null,
        currentPrice,
        priceChangeSinceTrade: priceChangeSince,
      },
      costBasis: {
        beforeTrade: prevQty.isZero()
          ? null
          : {
              avgPrice: prevInv.isZero()
                ? '0.00'
                : prevInv.div(prevQty).toFixed(2),
              totalQuantity: prevQty.toString(),
              totalInvested: prevInv.toFixed(2),
            },
        afterTrade: position
          ? {
              avgPrice: new Decimal(position.averagePrice.toString()).toFixed(
                2,
              ),
              totalQuantity: position.totalQuantity.toString(),
              totalInvested: new Decimal(
                position.totalInvested.toString(),
              ).toFixed(2),
            }
          : null,
      },
      feeImpact: {
        feesThisTrade: fees.toFixed(2),
        totalFeesForSymbol,
        feeAsPercentOfTrade: tradeTotal.isZero()
          ? '0.00'
          : fees.div(tradeTotal).mul(100).toFixed(4),
      },
      symbolTimeline: allSymbolTxns.map((t) => ({
        id: t.id,
        type: t.type,
        quantity: t.quantity.toString(),
        price: new Decimal(t.price.toString()).toFixed(2),
        fees: new Decimal((t as any).fees?.toString() ?? '0').toFixed(2),
        total: new Decimal(t.quantity.toString())
          .mul(t.price.toString())
          .toFixed(2),
        createdAt: t.createdAt,
        isCurrentTrade: t.id === tx.id,
      })),
      realizedImpact,
    };
  }

  // ── Position Detail (Feature 2) ───────────────────────────────────────────

  async getPositionDetail(userId: string, symbol: string) {
    const [position, txns, realizedGains, priceHistory, rawPrices] =
      await Promise.all([
        this.prisma.position.findFirst({
          where: { userId, symbol, deletedAt: null },
        }),
        this.prisma.transaction.findMany({
          where: { userId, symbol, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.realizedGain.findMany({
          where: { userId, symbol, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.stockPriceHistory.findMany({
          where: { symbol },
          orderBy: { timestamp: 'asc' },
          select: { price: true, timestamp: true },
          take: 500,
        }),
        this.redis.hgetall('market:prices'),
      ]);

    // Reconstruct from transactions if position row doesn't exist
    if (!position && txns.length === 0)
      throw new NotFoundException(`No position found for ${symbol}`);

    const { price: currentPrice } = this.parseLivePriceFull(rawPrices, symbol);

    let qty: Decimal;
    let avgPx: Decimal;
    let invested: Decimal;

    if (position) {
      avgPx = new Decimal(position.averagePrice.toString());
      qty = new Decimal(position.totalQuantity.toString());
      invested = new Decimal(position.totalInvested.toString());
    } else {
      // Reconstruct current state by replaying transactions
      let runQty = new Decimal(0);
      let runCost = new Decimal(0);
      for (const t of txns) {
        const tQty = new Decimal(t.quantity.toString());
        const tPx = new Decimal(t.price.toString());
        if (t.type === TransactionType.BUY) {
          runCost = runCost.add(tQty.mul(tPx));
          runQty = runQty.add(tQty);
        } else {
          const sellFraction = runQty.isZero()
            ? new Decimal(0)
            : tQty.div(runQty);
          runCost = runCost.sub(runCost.mul(sellFraction));
          runQty = runQty.sub(tQty);
          if (runQty.isNegative()) runQty = new Decimal(0);
          if (runCost.isNegative()) runCost = new Decimal(0);
        }
      }
      qty = runQty;
      avgPx = runQty.isZero() ? new Decimal(0) : runCost.div(runQty);
      invested = runCost;
    }

    const buyTxns = txns.filter((t) => t.type === TransactionType.BUY);

    // Original totals from all BUY transactions (never zeroed out)
    const totalQtyBought = buyTxns.reduce(
      (s, t) => s.add(t.quantity.toString()),
      new Decimal(0),
    );
    const totalBuyCostRaw = buyTxns.reduce(
      (s, t) =>
        s.add(new Decimal(t.quantity.toString()).mul(t.price.toString())),
      new Decimal(0),
    );
    const totalBuyFeesRaw = buyTxns.reduce(
      (s, t) => s.add((t as any).fees?.toString() ?? '0'),
      new Decimal(0),
    );
    const totalOriginalInvested = totalBuyCostRaw.add(totalBuyFeesRaw);
    // Weighted avg entry price across ALL buys (for break-even display on closed positions)
    const avgBuyPrice = totalQtyBought.isZero()
      ? new Decimal(0)
      : totalBuyCostRaw.div(totalQtyBought);

    // For open positions use live avgPx; for closed positions use historical avg buy price
    const displayAvgPx = qty.isZero() ? avgBuyPrice : avgPx;
    const displayInvested = invested.isZero()
      ? totalOriginalInvested
      : invested;

    const breakEvenPrice = displayAvgPx.toFixed(2);
    const gapToBreakEven =
      currentPrice != null && !displayAvgPx.isZero()
        ? (
            ((currentPrice - displayAvgPx.toNumber()) /
              displayAvgPx.toNumber()) *
            100
          ).toFixed(2)
        : null;
    const unrealizedPnL =
      currentPrice != null && !qty.isZero()
        ? new Decimal(currentPrice).sub(displayAvgPx).mul(qty).toFixed(2)
        : null;
    const unrealizedPct =
      currentPrice != null && !qty.isZero() && !displayInvested.isZero()
        ? new Decimal(currentPrice)
            .sub(displayAvgPx)
            .mul(qty)
            .div(displayInvested)
            .mul(100)
            .toFixed(2)
        : null;

    // days held = days since first BUY
    const firstBuy = buyTxns[0] ?? null;
    const daysHeld = firstBuy
      ? Math.floor((Date.now() - firstBuy.createdAt.getTime()) / 86400000)
      : null;

    // total fees
    const totalFeesPaid = txns
      .reduce(
        (sum, t) => sum.add((t as any).fees?.toString() ?? '0'),
        new Decimal(0),
      )
      .toFixed(2);

    // cost basis ladder — show all original buy lots
    // For open positions: scale to currently-held fraction; for closed: show all lots
    const heldFraction = totalQtyBought.isZero()
      ? new Decimal(1)
      : qty.isZero()
        ? new Decimal(1)
        : qty.div(totalQtyBought);

    const costBasisLadder = buyTxns.map((t) => {
      const buyPx = new Decimal(t.price.toString());
      const originalLotQty = new Decimal(t.quantity.toString());
      const displayLotQty = qty.isZero()
        ? originalLotQty
        : originalLotQty.mul(heldFraction);
      return {
        date: t.createdAt.toISOString(),
        quantity: parseFloat(displayLotQty.toFixed(4)),
        buyPrice: parseFloat(buyPx.toFixed(2)),
        lotValue: parseFloat(displayLotQty.mul(buyPx).toFixed(2)),
        isAboveBreakEven: currentPrice != null ? buyPx.lt(currentPrice) : false,
      };
    });

    // allTransactions with running cumulative + pnlOnSell matching
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

      // Match SELL to RealizedGain to get profit + return%
      let pnlOnSell: string | null = null;
      let returnPctOnSell: string | null = null;
      if (t.type === TransactionType.SELL) {
        const matched = realizedGains.find(
          (g) =>
            new Decimal(g.quantity.toString()).eq(tQty) &&
            new Decimal(g.sellPrice.toString()).eq(tPx) &&
            Math.abs(g.createdAt.getTime() - t.createdAt.getTime()) < 10000,
        );
        if (matched) {
          pnlOnSell = new Decimal(matched.profit.toString()).toFixed(2);
          const avgPx = new Decimal(matched.avgPrice.toString());
          returnPctOnSell = avgPx.isZero()
            ? null
            : tPx.sub(avgPx).div(avgPx).mul(100).toFixed(2);
        }
      }

      return {
        id: t.id,
        type: t.type,
        quantity: t.quantity.toString(),
        price: tPx.toFixed(2),
        fees: tFees.toFixed(2),
        total: tQty.mul(tPx).toFixed(2),
        createdAt: t.createdAt,
        cumulativeQty: cumQty.toFixed(4),
        cumulativeAvgPrice: cumQty.isZero()
          ? '0.00'
          : cumInv.div(cumQty).toFixed(2),
        pnlOnSell,
        returnPctOnSell,
      };
    });

    const isClosed = qty.isZero();
    const sellTxns = txns.filter((t) => t.type === TransactionType.SELL);
    const closedDate =
      isClosed && sellTxns.length > 0
        ? sellTxns[sellTxns.length - 1].createdAt.toISOString()
        : null;
    const totalRealizedPnL = realizedGains
      .reduce((s, g) => s.add(g.profit.toString()), new Decimal(0))
      .toFixed(2);
    const totalProceedsFromSells = sellTxns
      .reduce(
        (s, t) =>
          s.add(new Decimal(t.quantity.toString()).mul(t.price.toString())),
        new Decimal(0),
      )
      .toFixed(2);

    return {
      position: {
        symbol,
        totalQuantity: qty.toString(),
        averagePrice: displayAvgPx.toFixed(2),
        totalInvested: displayInvested.toFixed(2),
      },
      isClosed,
      closedDate,
      currentPrice,
      breakEvenPrice,
      gapToBreakEven,
      unrealizedPnL,
      unrealizedPct,
      daysHeld,
      totalFeesPaid,
      totalRealizedPnL,
      totalProceedsFromSells,
      costBasisLadder,
      priceHistory: priceHistory.map((h) => ({
        price: parseFloat(h.price.toString()),
        timestamp: h.timestamp.toISOString(),
      })),
      allTransactions,
      realizedGains: realizedGains.map((g) => ({
        id: g.id,
        quantity: g.quantity.toString(),
        sellPrice: new Decimal(g.sellPrice.toString()).toFixed(2),
        avgPrice: new Decimal(g.avgPrice.toString()).toFixed(2),
        profit: new Decimal(g.profit.toString()).toFixed(2),
        fees: new Decimal(g.fees.toString()).toFixed(2),
        returnPct: new Decimal(g.avgPrice.toString()).isZero()
          ? null
          : new Decimal(g.sellPrice.toString())
              .sub(g.avgPrice.toString())
              .div(g.avgPrice.toString())
              .mul(100)
              .toFixed(2),
        createdAt: g.createdAt,
      })),
    };
  }

  // ── Transactions Master (Feature 3) ───────────────────────────────────────

  async getTransactionsMaster(
    userId: string,
    filters: { symbol?: string; type?: string; from?: string; to?: string },
  ) {
    const where: any = { userId, deletedAt: null };
    if (filters.symbol) where.symbol = filters.symbol.toUpperCase();
    if (filters.type) where.type = filters.type.toUpperCase();
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from);
      if (filters.to) where.createdAt.lte = new Date(filters.to);
    }

    const [txns, realizedGains] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.realizedGain.findMany({ where: { userId, deletedAt: null } }),
    ]);

    let runningBalance = new Decimal(0);
    let feesCumulative = new Decimal(0);
    let totalFees = new Decimal(0);
    let totalRealizedPnL = new Decimal(0);
    let totalBuys = 0,
      totalSells = 0;

    for (const g of realizedGains)
      totalRealizedPnL = totalRealizedPnL.add(g.profit.toString());

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
          (g) =>
            g.symbol === t.symbol &&
            new Decimal(g.quantity.toString()).eq(qty) &&
            new Decimal(g.sellPrice.toString()).eq(px) &&
            Math.abs(g.createdAt.getTime() - t.createdAt.getTime()) < 10000,
        );
        if (matched)
          pnlOnSell = new Decimal(matched.profit.toString()).toFixed(2);
      }

      return {
        id: t.id,
        symbol: t.symbol,
        type: t.type,
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

  async getRiskAnalytics(userId: string, fromDate?: Date, toDate?: Date) {
    const [positions, rawPrices] = await Promise.all([
      this.positionsService.findByUser(userId),
      this.redis.hgetall('market:prices'),
    ]);

    let totalPortfolioValue = new Decimal(0);
    const items = positions.map((pos) => {
      const qty = new Decimal(pos.totalQuantity.toString());
      const avgPx = new Decimal(pos.averagePrice.toString());
      const currPx = this.parseLivePrice(rawPrices, pos.symbol);
      const effectivePx = currPx ?? avgPx;
      const value = qty.mul(effectivePx);
      const unrealizedPnL = currPx
        ? currPx.sub(avgPx).mul(qty)
        : new Decimal(0);
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
      totalPortfolioValue.isZero()
        ? new Decimal(0)
        : i.value.div(totalPortfolioValue).mul(100),
    );
    const hhi = weights.reduce((sum, w) => sum.add(w.pow(2)), new Decimal(0));
    const diversificationScore = Math.max(
      0,
      Math.min(100, 100 - hhi.div(100).toNumber()),
    );

    const sorted = [...items].sort((a, b) => b.value.sub(a.value).toNumber());
    const top3 = sorted.slice(0, 3);
    const top3Value = top3.reduce((s, i) => s.add(i.value), new Decimal(0));
    const top3Percent = totalPortfolioValue.isZero()
      ? '0.00'
      : top3Value.div(totalPortfolioValue).mul(100).toFixed(2);

    // max drawdown from timeline
    const tlFrom = fromDate ?? new Date(Date.now() - 90 * 86400000);
    const tlTo = toDate ?? new Date();
    const timelineData = await this.getTimeline(userId, tlFrom, tlTo);
    let drawdown = {
      maxDrawdownPct: '0.00',
      maxDrawdownAbs: '0.00',
      drawdownPeriod: null as null | { from: string; to: string },
    };
    if ((timelineData as any).timeline?.length > 1) {
      const tl: { timestamp: string; totalValue: string }[] = (
        timelineData as any
      ).timeline;
      let peak = parseFloat(tl[0].totalValue);
      let peakDate = tl[0].timestamp;
      let maxDD = 0,
        maxDDAbs = 0,
        troughDate = tl[0].timestamp;
      for (const pt of tl) {
        const val = parseFloat(pt.totalValue);
        if (val > peak) {
          peak = val;
          peakDate = pt.timestamp;
        }
        const dd = peak > 0 ? ((val - peak) / peak) * 100 : 0;
        if (dd < maxDD) {
          maxDD = dd;
          maxDDAbs = val - peak;
          troughDate = pt.timestamp;
        }
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
          percent: totalPortfolioValue.isZero()
            ? '0.00'
            : i.value.div(totalPortfolioValue).mul(100).toFixed(2),
        })),
        top3Percent,
        hhi: hhi.toFixed(0),
        diversificationScore: diversificationScore.toFixed(1),
      },
      positionRisk: items.map((i) => ({
        symbol: i.symbol,
        portfolioPercent: totalPortfolioValue.isZero()
          ? '0.00'
          : i.value.div(totalPortfolioValue).mul(100).toFixed(2),
        marketValue: i.value.toFixed(2),
        capitalAtRisk: i.value.toFixed(2),
        unrealizedPnL: i.unrealizedPnL.toFixed(2),
        unrealizedPct: i.invested.isZero()
          ? '0.00'
          : i.unrealizedPnL.div(i.invested).mul(100).toFixed(2),
      })),
      drawdown,
    };
  }

  // ── P&L Calendar (Feature 5) ──────────────────────────────────────────────

  async getPnLCalendar(userId: string, year: number) {
    const rows = await this.prisma.$queryRaw<
      { date: Date; pnl: string; trades: bigint }[]
    >`
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
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    let totalHoldDays = 0,
      holdCount = 0;
    let totalAnnualized = new Decimal(0),
      annualizedCount = 0;

    const trades = await Promise.all(
      gains.map(async (g) => {
        const qty = new Decimal(g.quantity.toString());
        const sellPx = new Decimal(g.sellPrice.toString());
        const avgPx = new Decimal(g.avgPrice.toString());
        const profit = new Decimal(g.profit.toString());

        const returnPct = avgPx.isZero()
          ? new Decimal(0)
          : sellPx.sub(avgPx).div(avgPx).mul(100);

        // find matching BUY
        const buyTx = await this.prisma.transaction.findFirst({
          where: {
            userId,
            symbol: g.symbol,
            type: TransactionType.BUY,
            deletedAt: null,
            createdAt: { lt: g.createdAt },
          },
          orderBy: { createdAt: 'desc' },
        });

        let holdDays: number | null = null;
        let annualizedReturn: string | null = null;
        if (buyTx) {
          holdDays = Math.max(
            1,
            Math.floor(
              (g.createdAt.getTime() - buyTx.createdAt.getTime()) / 86400000,
            ),
          );
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
        avgHoldDays:
          holdCount > 0 ? Math.round(totalHoldDays / holdCount) : null,
        avgAnnualizedReturn:
          annualizedCount > 0
            ? totalAnnualized.div(annualizedCount).toFixed(2)
            : null,
        gradeDistribution: grades,
      },
    };
  }

  // ── Smart Insights (Feature 9) ────────────────────────────────────────────

  async getInsights(userId: string) {
    const analytics = await this.getAnalytics(userId);
    const insights: {
      type: string;
      icon: string;
      message: string;
      symbol?: string;
      priority: number;
    }[] = [];

    const totalInv = parseFloat(analytics.portfolioValue.totalInvested);
    let totalFees = new Decimal(0);

    for (const pos of analytics.positions as any[]) {
      const avgPx = parseFloat(pos.averagePrice);
      const currPx = pos.currentPrice;
      const gap = currPx != null ? ((currPx - avgPx) / avgPx) * 100 : null;

      if (gap !== null && gap < -2) {
        insights.push({
          type: 'WARNING',
          icon: 'trending-down',
          message: `${pos.symbol} is ${Math.abs(gap).toFixed(1)}% below break-even (avg ${pos.averagePrice} EGP)`,
          symbol: pos.symbol,
          priority: 1,
        });
      }

      if (pos.daysSinceFirstBuy != null && pos.daysSinceFirstBuy > 30) {
        insights.push({
          type: 'INFO',
          icon: 'clock',
          message: `You've held ${pos.symbol} for ${pos.daysSinceFirstBuy} days (since avg cost ${pos.averagePrice} EGP)`,
          symbol: pos.symbol,
          priority: 3,
        });
      }

      if (pos.totalFeesPaid) totalFees = totalFees.add(pos.totalFeesPaid);
    }

    // concentration warning
    const positions = analytics.positions as any[];
    if (positions.length >= 3) {
      const rawPrices = await this.redis.hgetall('market:prices');
      let totalVal = new Decimal(0);
      const vals = positions.map((p) => {
        const px =
          this.parseLivePrice(rawPrices, p.symbol) ??
          new Decimal(p.averagePrice);
        const v = new Decimal(p.totalQuantity).mul(px);
        totalVal = totalVal.add(v);
        return { symbol: p.symbol, v };
      });
      const sorted = vals.sort((a, b) => b.v.sub(a.v).toNumber());
      const top3Pct = totalVal.isZero()
        ? 0
        : sorted
            .slice(0, 3)
            .reduce((s, i) => s.add(i.v), new Decimal(0))
            .div(totalVal)
            .mul(100)
            .toNumber();
      if (top3Pct > 60) {
        insights.push({
          type: 'WARNING',
          icon: 'concentration',
          message: `Top 3 holdings = ${top3Pct.toFixed(1)}% of portfolio — consider diversifying`,
          priority: 2,
        });
      }
    }

    // fee warning
    if (totalInv > 0 && (totalFees.toNumber() / totalInv) * 100 > 1) {
      insights.push({
        type: 'WARNING',
        icon: 'fee',
        message: `Fees have consumed ${((totalFees.toNumber() / totalInv) * 100).toFixed(2)}% of invested capital`,
        priority: 2,
      });
    }

    // all profitable
    const allProfitable = positions.every(
      (p: any) =>
        p.currentPrice != null &&
        parseFloat(p.currentPrice) > parseFloat(p.averagePrice),
    );
    if (positions.length > 0 && allProfitable) {
      insights.push({
        type: 'SUCCESS',
        icon: 'trending-up',
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
        where: { userId, symbol, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.position.findFirst({
        where: { userId, symbol, deletedAt: null },
      }),
      this.prisma.realizedGain.findMany({
        where: { userId, symbol, deletedAt: null },
      }),
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
        total: new Decimal(t.quantity.toString())
          .mul(t.price.toString())
          .toFixed(2),
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
    let currentTotalInvested = new Decimal(0);
    for (const p of positions) {
      qtyBySymbol[p.symbol] = new Decimal(p.totalQuantity.toString());
      currentTotalInvested = currentTotalInvested.add(p.totalInvested);
    }

    // Build cumulative invested timeline from ALL transactions (including before `from`)
    // so we know the invested amount at each point in time
    const allTxns = await this.prisma.transaction.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        symbol: true,
        type: true,
        quantity: true,
        price: true,
        createdAt: true,
      },
    });

    // Build sorted array of { timestamp, cumulativeInvested }
    let runningInvested = new Decimal(0);
    const investedSnapshots: { timestamp: Date; invested: Decimal }[] = [];
    for (const tx of allTxns) {
      const txTotal = new Decimal(tx.price.toString()).mul(
        new Decimal(tx.quantity.toString()),
      );
      if (tx.type === TransactionType.BUY) {
        runningInvested = runningInvested.add(txTotal);
      } else {
        runningInvested = runningInvested.sub(txTotal);
        if (runningInvested.lt(0)) runningInvested = new Decimal(0);
      }
      investedSnapshots.push({
        timestamp: tx.createdAt,
        invested: new Decimal(runningInvested.toString()),
      });
    }

    // Helper: find cumulative invested at a given timestamp via binary search
    const getInvestedAt = (ts: Date): Decimal => {
      if (investedSnapshots.length === 0) return currentTotalInvested;
      let lo = 0,
        hi = investedSnapshots.length - 1,
        best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (investedSnapshots[mid].timestamp <= ts) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return best >= 0 ? investedSnapshots[best].invested : new Decimal(0);
    };

    const history = await this.prisma.stockPriceHistory.findMany({
      where: { symbol: { in: symbols }, timestamp: { gte: from, lte: to } },
      orderBy: { timestamp: 'asc' },
      select: { symbol: true, price: true, timestamp: true },
    });

    const byTimestamp = new Map<
      string,
      { priceMap: Record<string, Decimal>; date: Date }
    >();
    for (const h of history) {
      const key = h.timestamp.toISOString();
      if (!byTimestamp.has(key))
        byTimestamp.set(key, { priceMap: {}, date: h.timestamp });
      byTimestamp.get(key)!.priceMap[h.symbol] = new Decimal(
        h.price.toString(),
      );
    }

    const timeline = Array.from(byTimestamp.entries()).map(
      ([timestamp, { priceMap, date }]) => {
        let totalValue = new Decimal(0);
        for (const symbol of symbols) {
          const px = priceMap[symbol];
          if (px) totalValue = totalValue.add(px.mul(qtyBySymbol[symbol]));
        }
        return {
          timestamp,
          totalValue: totalValue.toFixed(2),
          totalInvested: getInvestedAt(date).toFixed(2),
        };
      },
    );

    // Always append current live prices from Redis as the "now" data point
    // so the chart has at least 1 point even when price history is sparse
    const rawPrices = await this.redis.hgetall('market:prices');
    if (rawPrices) {
      let currentValue = new Decimal(0);
      let hasAnyPrice = false;
      for (const symbol of symbols) {
        const px = this.parseLivePrice(rawPrices, symbol);
        if (px) {
          currentValue = currentValue.add(px.mul(qtyBySymbol[symbol]));
          hasAnyPrice = true;
        }
      }
      if (hasAnyPrice) {
        const nowKey = new Date().toISOString();
        if (!byTimestamp.has(nowKey)) {
          timeline.push({
            timestamp: nowKey,
            totalValue: currentValue.toFixed(2),
            totalInvested: currentTotalInvested.toFixed(2),
          });
        }
      }
    }

    timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // If still < 2 points, fall back to transaction-based timeline
    if (timeline.length < 2) {
      const txTimeline = await this.buildTransactionTimeline(userId, from, to);
      if (txTimeline.length > 0) {
        const merged = [...timeline, ...txTimeline].sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp),
        );
        const seen = new Set<string>();
        const deduped = merged.filter((p) => {
          if (seen.has(p.timestamp)) return false;
          seen.add(p.timestamp);
          return true;
        });
        return { timeline: deduped };
      }
    }

    return { timeline };
  }

  private async buildTransactionTimeline(
    userId: string,
    from: Date,
    to: Date,
  ): Promise<
    { timestamp: string; totalValue: string; totalInvested: string }[]
  > {
    const allTxns = await this.prisma.transaction.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        symbol: true,
        type: true,
        quantity: true,
        price: true,
        createdAt: true,
      },
    });

    const holdings: Record<string, { qty: Decimal; lastPrice: Decimal }> = {};
    let cumulativeInvested = new Decimal(0);
    const result: {
      timestamp: string;
      totalValue: string;
      totalInvested: string;
    }[] = [];

    for (const tx of allTxns) {
      const txPrice = new Decimal(tx.price.toString());
      const txQty = new Decimal(tx.quantity.toString());
      const txTotal = txPrice.mul(txQty);

      if (!holdings[tx.symbol]) {
        holdings[tx.symbol] = { qty: new Decimal(0), lastPrice: txPrice };
      }
      holdings[tx.symbol].lastPrice = txPrice;

      if (tx.type === TransactionType.BUY) {
        holdings[tx.symbol].qty = holdings[tx.symbol].qty.add(txQty);
        cumulativeInvested = cumulativeInvested.add(txTotal);
      } else {
        holdings[tx.symbol].qty = holdings[tx.symbol].qty.sub(txQty);
        if (holdings[tx.symbol].qty.lt(0))
          holdings[tx.symbol].qty = new Decimal(0);
        cumulativeInvested = cumulativeInvested.sub(txTotal);
        if (cumulativeInvested.lt(0)) cumulativeInvested = new Decimal(0);
      }

      if (tx.createdAt >= from && tx.createdAt <= to) {
        let value = new Decimal(0);
        for (const h of Object.values(holdings)) {
          if (h.qty.gt(0)) value = value.add(h.lastPrice.mul(h.qty));
        }
        result.push({
          timestamp: tx.createdAt.toISOString(),
          totalValue: value.toFixed(2),
          totalInvested: cumulativeInvested.toFixed(2),
        });
      }
    }

    return result;
  }

  // ── Realized Gains List ───────────────────────────────────────────────────

  async getRealizedGainsList(userId: string, fromDate?: Date, toDate?: Date) {
    const dateFilter =
      fromDate || toDate
        ? {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          }
        : undefined;
    const [gains, buyTxns] = await Promise.all([
      this.prisma.realizedGain.findMany({
        where: {
          userId,
          deletedAt: null,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.transaction.findMany({
        where: { userId, type: TransactionType.BUY, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { symbol: true, createdAt: true },
      }),
    ]);

    // First BUY date per symbol for hold-days calculation
    const firstBuyBySymbol: Record<string, Date> = {};
    for (const tx of buyTxns) {
      if (!firstBuyBySymbol[tx.symbol])
        firstBuyBySymbol[tx.symbol] = tx.createdAt;
    }

    const totalProfit = gains.reduce(
      (s, g) => s.add(new Decimal(g.profit.toString())),
      new Decimal(0),
    );
    const totalFees = gains.reduce(
      (s, g) => s.add(new Decimal(g.fees.toString())),
      new Decimal(0),
    );
    const totalQuantity = gains.reduce(
      (s, g) => s.add(new Decimal(g.quantity.toString())),
      new Decimal(0),
    );
    const totalCostBasis = gains.reduce(
      (s, g) =>
        s.add(
          new Decimal(g.avgPrice.toString()).mul(
            new Decimal(g.quantity.toString()),
          ),
        ),
      new Decimal(0),
    );
    const totalReturn = totalCostBasis.isZero()
      ? null
      : totalProfit.div(totalCostBasis).mul(100).toFixed(2);
    const uniqueSymbols = new Set(gains.map((g) => g.symbol)).size;

    // Average hold days: (sellDate - firstBuyDate) per gain, then average
    const holdDaysArr: number[] = [];
    const gainRecords = gains.map((g) => {
      const profit = new Decimal(g.profit.toString());
      const sellPrice = new Decimal(g.sellPrice.toString());
      const avgPrice = new Decimal(g.avgPrice.toString());
      const qty = new Decimal(g.quantity.toString());
      const costBasis = avgPrice.mul(qty);
      const returnPct = costBasis.isZero()
        ? null
        : profit.div(costBasis).mul(100).toFixed(2);

      const firstBuy = firstBuyBySymbol[g.symbol];
      const holdDays = firstBuy
        ? Math.max(
            0,
            Math.floor((g.createdAt.getTime() - firstBuy.getTime()) / 86400000),
          )
        : null;
      if (holdDays != null) holdDaysArr.push(holdDays);

      return {
        id: g.id,
        symbol: g.symbol,
        quantity: qty.toFixed(2),
        sellPrice: sellPrice.toFixed(2),
        avgPrice: avgPrice.toFixed(2),
        profit: profit.toFixed(2),
        fees: g.fees.toFixed(2),
        returnPct,
        holdDays,
        date: g.createdAt.toISOString(),
      };
    });

    const avgHoldDays = holdDaysArr.length
      ? Math.round(holdDaysArr.reduce((s, d) => s + d, 0) / holdDaysArr.length)
      : null;

    return {
      gains: gainRecords,
      summary: {
        totalProfit: totalProfit.toFixed(2),
        totalFees: totalFees.toFixed(2),
        totalQuantity: totalQuantity.toFixed(2),
        totalCostBasis: totalCostBasis.toFixed(2),
        totalReturn,
        uniqueSymbols,
        avgHoldDays,
        count: gains.length,
        winCount: gains.filter((g) => new Decimal(g.profit.toString()).gt(0))
          .length,
        lossCount: gains.filter((g) => new Decimal(g.profit.toString()).lte(0))
          .length,
      },
    };
  }

  // ── Portfolio Allocation ──────────────────────────────────────────────────

  async getAllocation(userId: string) {
    const positions = await this.positionsService.findByUser(userId);
    if (!positions.length) return { bySymbol: [] };

    const rawPrices = await this.redis.hgetall('market:prices');

    let totalValue = new Decimal(0);
    const items: {
      symbol: string;
      value: Decimal;
      qty: Decimal;
      avgPx: Decimal;
      currPx: Decimal | null;
    }[] = [];

    for (const pos of positions) {
      const qty = new Decimal(pos.totalQuantity.toString());
      const avgPx = new Decimal(pos.averagePrice.toString());
      const currPx = this.parseLivePrice(rawPrices, pos.symbol);
      const effectivePx = currPx ?? avgPx;
      const value = qty.mul(effectivePx);
      totalValue = totalValue.add(value);
      items.push({ symbol: pos.symbol, value, qty, avgPx, currPx });
    }

    const pct = (v: Decimal) =>
      totalValue.isZero() ? '0.00' : v.div(totalValue).mul(100).toFixed(2);

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

    return { bySymbol };
  }

  // ── Closed Positions (full history of exited trades) ─────────────────────

  async getClosedPositions(userId: string, fromDate?: Date, toDate?: Date) {
    const dateFilter =
      fromDate || toDate
        ? {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          }
        : undefined;
    const [positions, txns, gains] = await Promise.all([
      this.positionsService.findByUser(userId),
      this.prisma.transaction.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.realizedGain.findMany({
        where: {
          userId,
          deletedAt: null,
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Use RealizedGain as source — ALL symbols with any sell history (partial or full)
    const symbolsWithGains = [...new Set(gains.map((g) => g.symbol))];
    if (symbolsWithGains.length === 0) return [];

    const positionMap = new Map(positions.map((p) => [p.symbol, p]));

    return symbolsWithGains.map((symbol) => {
      const pos = positionMap.get(symbol);
      const symbolTxns = txns.filter((t) => t.symbol === symbol);
      const symbolGains = gains.filter((g) => g.symbol === symbol);

      const buyTxns = symbolTxns.filter((t) => t.type === TransactionType.BUY);
      const sellTxns = symbolTxns.filter(
        (t) => t.type === TransactionType.SELL,
      );

      const currentQty = pos
        ? new Decimal(pos.totalQuantity.toString())
        : new Decimal(0);
      const isClosed = currentQty.isZero();

      // Cost basis = sum of (qty * price + fees) for all BUY transactions
      const totalBuyCost = buyTxns.reduce(
        (s, t) =>
          s
            .add(new Decimal(t.quantity.toString()).mul(t.price.toString()))
            .add((t as any).fees?.toString() ?? '0'),
        new Decimal(0),
      );
      const totalProceeds = sellTxns.reduce(
        (s, t) =>
          s.add(new Decimal(t.quantity.toString()).mul(t.price.toString())),
        new Decimal(0),
      );
      const totalFees = symbolTxns.reduce(
        (s, t) => s.add((t as any).fees?.toString() ?? '0'),
        new Decimal(0),
      );
      const totalProfit = symbolGains.reduce(
        (s, g) => s.add(g.profit.toString()),
        new Decimal(0),
      );

      // Cost of the portion that was sold (not total buy cost)
      const totalSoldQty = symbolGains.reduce(
        (s, g) => s.add(new Decimal(g.quantity.toString())),
        new Decimal(0),
      );
      const avgBuyPrice =
        buyTxns.length > 0
          ? buyTxns
              .reduce(
                (s, t) =>
                  s.add(
                    new Decimal(t.quantity.toString()).mul(t.price.toString()),
                  ),
                new Decimal(0),
              )
              .div(
                buyTxns.reduce(
                  (s, t) => s.add(new Decimal(t.quantity.toString())),
                  new Decimal(0),
                ),
              )
          : new Decimal(0);
      const soldCostBasis = totalSoldQty.mul(avgBuyPrice);
      const returnPct = soldCostBasis.isZero()
        ? null
        : totalProfit.div(soldCostBasis).mul(100).toFixed(2);

      const openDate = buyTxns[0]?.createdAt?.toISOString() ?? null;
      const closeDate =
        isClosed && sellTxns.length > 0
          ? sellTxns[sellTxns.length - 1].createdAt.toISOString()
          : null;
      const lastSellDate =
        sellTxns.length > 0
          ? sellTxns[sellTxns.length - 1].createdAt.toISOString()
          : null;
      const holdDays =
        openDate && closeDate
          ? Math.floor(
              (new Date(closeDate).getTime() - new Date(openDate).getTime()) /
                86400000,
            )
          : null;

      const winCount = symbolGains.filter((g) =>
        new Decimal(g.profit.toString()).gt(0),
      ).length;
      const lossCount = symbolGains.length - winCount;

      return {
        symbol,
        isClosed,
        currentQty: currentQty.toFixed(8),
        totalBuyCost: totalBuyCost.toFixed(2),
        totalProceeds: totalProceeds.toFixed(2),
        totalProfit: totalProfit.toFixed(2),
        totalFees: totalFees.toFixed(2),
        returnPct,
        openDate,
        closeDate,
        lastSellDate,
        holdDays,
        buyCount: buyTxns.length,
        sellCount: sellTxns.length,
        winCount,
        lossCount,
      };
    });
  }
}
