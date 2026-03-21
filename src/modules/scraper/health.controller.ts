import { Controller, Get, Post } from '@nestjs/common';
import { getMarketStatus } from './utils/market-hours';
import { ScraperService } from './scraper.service';

@Controller('health')
export class HealthController {
  constructor(private readonly scraper: ScraperService) {}

  @Get()
  check() {
    const marketStatus = getMarketStatus();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      marketStatus,
    };
  }

  @Post('trigger/list')
  async triggerList() {
    await this.scraper.triggerListScrape();
    return { queued: 'list-scraper' };
  }

  @Post('trigger/prices')
  async triggerPrices() {
    await this.scraper.triggerPriceScrape();
    return { queued: 'price-scraper', force: true };
  }
}
