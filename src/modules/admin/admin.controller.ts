import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SchedulerService } from '../scraper/scheduler.service';
import { PrismaService } from '../../database/prisma.service';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('scraper/list')
  async triggerList() {
    void this.scheduler.runListScrape();
    return { message: 'List scrape triggered' };
  }

  @Post('scraper/prices')
  async triggerPrices() {
    void this.scheduler.forcePriceScrape();
    return { message: 'Price scrape triggered (market hours bypassed)' };
  }

  @Post('migrate/soft-delete')
  async migrateSoftDelete() {
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`,
    );
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE positions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`,
    );
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE realized_gains ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`,
    );
    return { message: 'Soft-delete columns added to transactions, positions, and realized_gains' };
  }
}
