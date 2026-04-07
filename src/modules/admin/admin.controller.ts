import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SchedulerService } from '../scraper/scheduler.service';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly scheduler: SchedulerService) {}

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
}
