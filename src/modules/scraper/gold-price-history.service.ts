import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RedisWriterService } from './redis-writer.service';

@Injectable()
export class GoldPriceHistoryService {
  private readonly logger = new Logger(GoldPriceHistoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisWriterService,
  ) {}

  /** Create daily snapshot of gold prices from Redis → PostgreSQL */
  async createDailySnapshot(): Promise<number> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const existingToday = await this.prisma.goldPriceHistory.count({
      where: { timestamp: { gte: todayStart } },
    });
    if (existingToday > 0) {
      this.logger.log(
        `Gold archiver: snapshots already exist for today — skipping`,
      );
      return 0;
    }

    const raw = await this.redis.hgetall('market:gold:prices');
    if (!raw || Object.keys(raw).length === 0) {
      this.logger.warn('Gold archiver: no gold prices in Redis — skipping');
      return 0;
    }

    const now = new Date();
    const records: {
      categoryId: string;
      buyPrice: number;
      sellPrice: number;
      globalSpotUsd: number | null;
      timestamp: Date;
    }[] = [];

    for (const [categoryId, json] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(json) as {
          buyPrice?: number;
          sellPrice?: number;
          globalSpotUsd?: number | null;
        };
        if (!parsed.buyPrice || !parsed.sellPrice) continue;
        records.push({
          categoryId,
          buyPrice: parsed.buyPrice,
          sellPrice: parsed.sellPrice,
          globalSpotUsd: parsed.globalSpotUsd ?? null,
          timestamp: now,
        });
      } catch {
        this.logger.warn(`Failed to parse gold price data for ${categoryId}`);
      }
    }

    if (records.length === 0) return 0;

    await this.prisma.goldPriceHistory.createMany({ data: records });
    this.logger.log(
      `Gold archiver: archived ${records.length} gold price snapshots`,
    );
    return records.length;
  }

  /** Get price history for a gold category */
  async getHistory(categoryId: string, from?: Date, to?: Date, limit = 500) {
    return this.prisma.goldPriceHistory.findMany({
      where: {
        categoryId,
        ...(from || to
          ? {
              timestamp: { ...(from && { gte: from }), ...(to && { lte: to }) },
            }
          : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }
}
