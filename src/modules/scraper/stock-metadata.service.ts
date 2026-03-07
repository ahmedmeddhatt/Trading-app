import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class StockMetadataService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertStock(
    symbol: string,
    name?: string,
    sector?: string,
    marketCap?: string,
    pe?: number | null,
  ): Promise<void> {
    await this.prisma.stock.upsert({
      where: { symbol },
      update: { name, sector, marketCap, pe },
      create: { symbol, name, sector, marketCap, pe },
    });
  }
}
