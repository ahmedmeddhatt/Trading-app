import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { StocksQueryDto } from './dto/stocks-query.dto';
import { Prisma } from '@prisma/client';

const CACHE_TTL = 30; // seconds
const DASHBOARD_CACHE_KEY = 'cache:dashboard';

interface LivePrice {
  price: number;
  changePercent: number;
  timestamp: string;
}

@Injectable()
export class StocksService {
  private readonly logger = new Logger(StocksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async getAllLivePrices(): Promise<Record<string, LivePrice>> {
    const raw = await this.redis.hgetall('market:prices');
    const result: Record<string, LivePrice> = {};
    for (const [symbol, json] of Object.entries(raw ?? {})) {
      try { result[symbol] = JSON.parse(json); } catch { /* skip */ }
    }
    return result;
  }

  private enrichWithLive(symbol: string, prices: Record<string, LivePrice>) {
    const live = prices[symbol];
    return {
      price: live?.price ?? null,
      changePercent: live?.changePercent ?? null,
      lastUpdate: live?.timestamp ?? null,
    };
  }

  // ── Dashboard ────────────────────────────────────────────────────────────

  async getDashboard(userId?: string) {
    const cached = await this.redis.get(DASHBOARD_CACHE_KEY);
    const prices = await this.getAllLivePrices();

    let base: { hottest: unknown[]; recommended: unknown[]; lowest: unknown[] };

    if (cached) {
      base = JSON.parse(cached);
    } else {
      const priceEntries = Object.entries(prices).map(([symbol, d]) => ({ symbol, ...d }));

      const hottest = [...priceEntries]
        .sort((a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0))
        .slice(0, 5)
        .map(({ symbol, price, changePercent, timestamp }) => ({ symbol, price, changePercent, lastUpdate: timestamp }));

      const lowest = [...priceEntries]
        .filter((e) => e.price != null)
        .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))
        .slice(0, 5)
        .map(({ symbol, price, changePercent, timestamp }) => ({ symbol, price, changePercent, lastUpdate: timestamp }));

      const dbStocks = await this.prisma.stock.findMany({
        where: { pe: { not: null }, marketCap: { not: null } },
        orderBy: { pe: 'asc' },
        take: 5,
      });

      const recommended = dbStocks.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        marketCap: s.marketCap,
        pe: s.pe?.toString() ?? null,
        ...this.enrichWithLive(s.symbol, prices),
      }));

      base = { hottest, recommended, lowest };
      const freshCount = Object.values(prices).filter((lp) => {
        if (!lp.timestamp) return false;
        return Date.now() - new Date(lp.timestamp).getTime() <= 5 * 60 * 1000;
      }).length;
      const cacheTtl = freshCount > 0 ? CACHE_TTL : 5;
      await this.redis.setex(DASHBOARD_CACHE_KEY, cacheTtl, JSON.stringify(base));
    }

    let myStocks: unknown[] = [];
    if (userId) {
      const positions = await this.prisma.position.findMany({ where: { userId } });
      myStocks = positions.map((pos) => ({
        symbol: pos.symbol,
        totalQuantity: pos.totalQuantity.toString(),
        averagePrice: pos.averagePrice.toFixed(2),
        totalInvested: pos.totalInvested.toFixed(2),
        ...this.enrichWithLive(pos.symbol, prices),
      }));
    }

    // ── Price freshness metadata ──────────────────────────────────────────
    const STALE_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    const totalDbSymbols = await this.prisma.stock.count();
    let symbolsWithFreshPrice = 0;
    let symbolsWithStalePrice = 0;
    let oldestUpdate: Date | null = null;
    let newestUpdate: Date | null = null;

    for (const lp of Object.values(prices)) {
      if (!lp.timestamp) continue;
      const ts = new Date(lp.timestamp);
      const age = now - ts.getTime();
      if (age <= STALE_MS) symbolsWithFreshPrice++;
      else symbolsWithStalePrice++;
      if (!oldestUpdate || ts < oldestUpdate) oldestUpdate = ts;
      if (!newestUpdate || ts > newestUpdate) newestUpdate = ts;
    }

    const pricesMeta = {
      totalSymbols: totalDbSymbols,
      symbolsWithFreshPrice,
      symbolsWithStalePrice,
      symbolsWithNoPrice: Math.max(0, totalDbSymbols - symbolsWithFreshPrice - symbolsWithStalePrice),
      oldestUpdate: oldestUpdate?.toISOString() ?? null,
      newestUpdate: newestUpdate?.toISOString() ?? null,
    };

    return { ...base, myStocks, pricesMeta };
  }

  // ── Price History ─────────────────────────────────────────────────────────

  async getHistory(symbol: string, from?: Date, to?: Date) {
    const where: Prisma.StockPriceHistoryWhereInput = {
      symbol,
      ...(from || to
        ? { timestamp: { ...(from && { gte: from }), ...(to && { lte: to }) } }
        : {}),
    };
    const rows = await this.prisma.stockPriceHistory.findMany({
      where,
      orderBy: { timestamp: 'asc' },
      select: { price: true, timestamp: true },
    });
    return rows.map((r) => ({ price: r.price.toNumber(), timestamp: r.timestamp.toISOString() }));
  }

  // ── Single stock ─────────────────────────────────────────────────────────

  async getBySymbol(symbol: string) {
    const stock = await this.prisma.stock.findUnique({ where: { symbol } });
    if (!stock) return null;
    const prices = await this.getAllLivePrices();
    return {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      marketCap: stock.marketCap,
      pe: stock.pe?.toString() ?? null,
      ...this.enrichWithLive(stock.symbol, prices),
    };
  }

  // ── Search / Filter ───────────────────────────────────────────────────────

  async searchStocks(query: StocksQueryDto) {
    const { search, sector, minPE, maxPE, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.StockWhereInput = {
      ...(search && {
        OR: [
          { symbol: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ],
      }),
      ...(sector && { sector: { contains: sector, mode: 'insensitive' } }),
      ...(minPE != null || maxPE != null
        ? { pe: { ...(minPE != null && { gte: minPE }), ...(maxPE != null && { lte: maxPE }) } }
        : {}),
    };

    const [stocks, total] = await Promise.all([
      this.prisma.stock.findMany({ where, skip, take: limit, orderBy: { symbol: 'asc' } }),
      this.prisma.stock.count({ where }),
    ]);

    const prices = await this.getAllLivePrices();

    const data = stocks.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      marketCap: s.marketCap,
      pe: s.pe?.toString() ?? null,
      ...this.enrichWithLive(s.symbol, prices),
    }));

    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
