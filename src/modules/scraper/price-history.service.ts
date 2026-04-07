import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RedisWriterService } from './redis-writer.service';

@Injectable()
export class PriceHistoryService {
  private readonly logger = new Logger(PriceHistoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisWriterService,
  ) {}

  /**
   * Creates one daily snapshot per symbol. Checks that:
   * 1. No snapshot already exists for today (prevents duplicates on restart)
   * 2. Redis prices are fresh (from today's session, not stale from yesterday)
   * Returns the number of records inserted.
   */
  async createDailySnapshot(): Promise<number> {
    // Check if we already have snapshots for today
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setUTCHours(23, 59, 59, 999);

    const existingToday = await this.prisma.stockPriceHistory.count({
      where: { timestamp: { gte: todayStart, lte: todayEnd } },
    });
    if (existingToday > 0) {
      this.logger.log(`Archiver: ${existingToday} snapshots already exist for today — skipping`);
      return 0;
    }

    const raw = await this.redis.hgetall('market:prices');
    if (!raw || Object.keys(raw).length === 0) {
      this.logger.warn('Archiver: no prices in Redis — skipping');
      return 0;
    }

    const now = new Date();
    const maxAgeMs = 6 * 60 * 60 * 1_000; // 6 hours — prices must be from today's session
    const records: { symbol: string; price: number; changePercent: number | null; timestamp: Date }[] = [];

    for (const [symbol, json] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(json) as { price?: number; changePercent?: number; timestamp?: string };
        if (parsed.price == null) continue;

        // Skip stale prices (e.g. from yesterday if scraper failed today)
        if (parsed.timestamp) {
          const age = now.getTime() - new Date(parsed.timestamp).getTime();
          if (age > maxAgeMs) continue;
        }

        records.push({
          symbol,
          price: parsed.price,
          changePercent: parsed.changePercent ?? null,
          timestamp: now,
        });
      } catch {
        this.logger.warn(`Failed to parse price data for ${symbol}`);
      }
    }

    if (records.length === 0) {
      this.logger.warn('Archiver: all prices are stale or missing — skipping');
      return 0;
    }

    const existingSymbols = await this.prisma.stock.findMany({ select: { symbol: true } });
    const validSymbols = new Set(existingSymbols.map((s) => s.symbol));
    const validRecords = records.filter((r) => validSymbols.has(r.symbol));

    if (validRecords.length === 0) {
      this.logger.warn('Archiver: no valid symbols to archive (stocks table may be empty)');
      return 0;
    }

    await this.prisma.stockPriceHistory.createMany({ data: validRecords });

    this.logger.log(`Archived ${validRecords.length} price snapshots (${records.length - validRecords.length} skipped — not in stocks table)`);
    return validRecords.length;
  }

  async getPriceAtTimestamp(symbol: string, date: Date) {
    return this.prisma.stockPriceHistory.findFirst({
      where: { symbol, timestamp: { lte: date } },
      orderBy: { timestamp: 'desc' },
    });
  }

  async ensurePartitionExists(date: Date): Promise<void> {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1; // 1-based
    const table = `stock_price_history_y${year}_m${String(month).padStart(2, '0')}`;
    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);

    this.logger.log(
      `Ensuring partition exists for ${date.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
      { table },
    );

    await this.prisma.$executeRaw(
      Prisma.sql`CREATE TABLE IF NOT EXISTS ${Prisma.raw(`"${table}"`)} PARTITION OF "stock_price_history" FOR VALUES FROM (${start}::timestamptz) TO (${end}::timestamptz)`,
    );
  }
}
