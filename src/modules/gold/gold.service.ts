import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { GoldPriceHistoryService } from '../scraper/gold-price-history.service';

const GOLD_DASHBOARD_CACHE_KEY = 'cache:gold:dashboard';
const CACHE_TTL = 120; // 2 minutes

interface GoldLivePrice {
  buyPrice: number;
  sellPrice: number;
  changePercent: number;
  timestamp: string;
  source: string;
  globalSpotUsd: number | null;
}

@Injectable()
export class GoldService {
  private readonly logger = new Logger(GoldService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly goldPriceHistory: GoldPriceHistoryService,
  ) {}

  private async getAllGoldPrices(): Promise<Record<string, GoldLivePrice>> {
    const raw = await this.redis.hgetall('market:gold:prices');
    const result: Record<string, GoldLivePrice> = {};
    for (const [categoryId, json] of Object.entries(raw ?? {})) {
      try {
        result[categoryId] = JSON.parse(json) as GoldLivePrice;
      } catch {
        /* skip */
      }
    }
    return result;
  }

  async getDashboard(userId?: string) {
    const cached = await this.redis.get(GOLD_DASHBOARD_CACHE_KEY);
    if (cached) {
      const base = JSON.parse(cached) as Record<string, unknown>;
      const myGold = userId ? await this.getMyGold(userId) : [];
      return { ...base, myGold } as Record<string, unknown>;
    }

    const categories = await this.prisma.goldCategory.findMany();
    const prices = await this.getAllGoldPrices();

    const items = categories.map((cat) => {
      const live = prices[cat.id];
      return {
        categoryId: cat.id,
        nameAr: cat.nameAr,
        nameEn: cat.nameEn,
        unit: cat.unit,
        purity: cat.purity?.toString() ?? null,
        buyPrice: live?.buyPrice ?? null,
        sellPrice: live?.sellPrice ?? null,
        changePercent: live?.changePercent ?? 0,
        lastUpdate: live?.timestamp ?? null,
        source: live?.source ?? null,
        globalSpotUsd: live?.globalSpotUsd ?? null,
      };
    });

    // Top movers by absolute change
    const topMovers = [...items]
      .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
      .slice(0, 3);

    // Most traded categories (21K and 24K are most popular in Egypt)
    const popular = items.filter((i) =>
      ['GOLD_21K', 'GOLD_24K', 'GOLD_POUND'].includes(i.categoryId),
    );

    const base = { categories: items, topMovers, popular };
    await this.redis.setex(
      GOLD_DASHBOARD_CACHE_KEY,
      CACHE_TTL,
      JSON.stringify(base),
    );

    const myGold = userId ? await this.getMyGold(userId) : [];
    return { ...base, myGold };
  }

  private async getMyGold(userId: string) {
    const positions = await this.prisma.position.findMany({
      where: { userId, assetType: 'GOLD', deletedAt: null },
    });
    const prices = await this.getAllGoldPrices();
    return positions.map((pos) => {
      const live = prices[pos.symbol];
      return {
        categoryId: pos.symbol,
        totalQuantity: pos.totalQuantity.toString(),
        averagePrice: pos.averagePrice.toFixed(2),
        totalInvested: pos.totalInvested.toFixed(2),
        currentSellPrice: live?.sellPrice ?? null,
        currentBuyPrice: live?.buyPrice ?? null,
        changePercent: live?.changePercent ?? 0,
        lastUpdate: live?.timestamp ?? null,
      };
    });
  }

  async getCategories() {
    const categories = await this.prisma.goldCategory.findMany();
    const prices = await this.getAllGoldPrices();

    // Get yesterday's closing prices for daily change calculation
    const yesterdayStart = new Date();
    yesterdayStart.setUTCHours(0, 0, 0, 0);
    yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
    const yesterdayEnd = new Date(yesterdayStart);
    yesterdayEnd.setUTCHours(23, 59, 59, 999);

    const yesterdaySnapshots = await this.prisma.goldPriceHistory.findMany({
      where: { timestamp: { gte: yesterdayStart, lte: yesterdayEnd } },
      orderBy: { timestamp: 'desc' },
    });
    const yesterdayPrices = new Map<string, number>();
    for (const snap of yesterdaySnapshots) {
      if (!yesterdayPrices.has(snap.categoryId)) {
        yesterdayPrices.set(snap.categoryId, Number(snap.sellPrice));
      }
    }

    return categories.map((cat) => {
      const live = prices[cat.id];
      const prevSell = yesterdayPrices.get(cat.id);
      const changePercent =
        live?.sellPrice && prevSell
          ? +(((live.sellPrice - prevSell) / prevSell) * 100).toFixed(2)
          : 0;

      return {
        categoryId: cat.id,
        nameAr: cat.nameAr,
        nameEn: cat.nameEn,
        unit: cat.unit,
        purity: cat.purity?.toString() ?? null,
        weightGrams: cat.weightGrams?.toString() ?? null,
        buyPrice: live?.buyPrice ?? null,
        sellPrice: live?.sellPrice ?? null,
        changePercent,
        lastUpdate: live?.timestamp ?? null,
        spread: live
          ? +(
              ((live.buyPrice - live.sellPrice) / live.sellPrice) *
              100
            ).toFixed(2)
          : null,
      };
    });
  }

  async getByCategory(categoryId: string) {
    const category = await this.prisma.goldCategory.findUnique({
      where: { id: categoryId },
    });
    if (!category) return null;

    const prices = await this.getAllGoldPrices();
    const live = prices[categoryId];

    const recentHistory = await this.goldPriceHistory.getHistory(
      categoryId,
      undefined,
      undefined,
      30,
    );

    return {
      categoryId: category.id,
      nameAr: category.nameAr,
      nameEn: category.nameEn,
      unit: category.unit,
      purity: category.purity?.toString() ?? null,
      weightGrams: category.weightGrams?.toString() ?? null,
      buyPrice: live?.buyPrice ?? null,
      sellPrice: live?.sellPrice ?? null,
      changePercent: live?.changePercent ?? 0,
      lastUpdate: live?.timestamp ?? null,
      globalSpotUsd: live?.globalSpotUsd ?? null,
      spread: live
        ? +(((live.buyPrice - live.sellPrice) / live.sellPrice) * 100).toFixed(
            2,
          )
        : null,
      recentHistory: recentHistory.map((h) => ({
        buyPrice: h.buyPrice.toNumber(),
        sellPrice: h.sellPrice.toNumber(),
        globalSpotUsd: h.globalSpotUsd?.toNumber() ?? null,
        timestamp: h.timestamp.toISOString(),
      })),
    };
  }

  async getHistory(categoryId: string, from?: Date, to?: Date) {
    const rows = await this.goldPriceHistory.getHistory(
      categoryId,
      from,
      to,
      500,
    );
    return rows.map((r) => ({
      buyPrice: r.buyPrice.toNumber(),
      sellPrice: r.sellPrice.toNumber(),
      globalSpotUsd: r.globalSpotUsd?.toNumber() ?? null,
      timestamp: r.timestamp.toISOString(),
    }));
  }
}
