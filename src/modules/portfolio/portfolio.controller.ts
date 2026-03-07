import { Controller, Get, Param, Query } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';

@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get(':userId/analytics')
  getAnalytics(@Param('userId') userId: string) {
    return this.portfolioService.getAnalytics(userId);
  }

  @Get(':userId/timeline')
  getTimeline(
    @Param('userId') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.portfolioService.getTimeline(userId, from, to);
  }

  @Get(':userId/allocation')
  getAllocation(@Param('userId') userId: string) {
    return this.portfolioService.getAllocation(userId);
  }

  @Get(':userId/stock/:symbol/history')
  getStockHistory(
    @Param('userId') userId: string,
    @Param('symbol') symbol: string,
  ) {
    return this.portfolioService.getStockHistory(userId, symbol);
  }

  @Get(':userId')
  getPortfolioSummary(@Param('userId') userId: string) {
    return this.portfolioService.getPortfolioSummary(userId);
  }
}
