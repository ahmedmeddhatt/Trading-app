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

  async createSnapshots(): Promise<void> {
    const raw = await this.redis.hgetall('market:prices');
    if (!raw || Object.keys(raw).length === 0) return;

    const records: { symbol: string; price: number; changePercent: number | null; timestamp: Date }[] = [];
    const now = new Date();

    for (const [symbol, json] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(json) as { price?: number; changePercent?: number; timestamp?: string };
        if (parsed.price == null) continue;
        records.push({
          symbol,
          price: parsed.price,
          changePercent: parsed.changePercent ?? null,
          timestamp: parsed.timestamp ? new Date(parsed.timestamp) : now,
        });
      } catch {
        this.logger.warn(`Failed to parse price data for ${symbol}`);
      }
    }

    if (records.length === 0) return;

    await this.prisma.stockPriceHistory.createMany({
      data: records,
      skipDuplicates: true,
    });

    this.logger.log(`Archived ${records.length} price snapshots`);
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
