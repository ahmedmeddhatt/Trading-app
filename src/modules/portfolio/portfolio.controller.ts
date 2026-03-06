import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get(':userId')
  getPortfolioSummary(@Param('userId') userId: string) {
    return this.portfolioService.getPortfolioSummary(userId);
  }

  @Get(':userId/analytics')
  @UseGuards(JwtAuthGuard)
  getAnalytics(@Param('userId') userId: string) {
    return this.portfolioService.getAnalytics(userId);
  }

  @Get(':userId/stock/:symbol/history')
  @UseGuards(JwtAuthGuard)
  getStockHistory(
    @Param('userId') userId: string,
    @Param('symbol') symbol: string,
  ) {
    return this.portfolioService.getStockHistory(userId, symbol.toUpperCase());
  }

  @Get(':userId/timeline')
  @UseGuards(JwtAuthGuard)
  getTimeline(
    @Param('userId') userId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    return this.portfolioService.getTimeline(userId, fromDate, toDate);
  }

  @Get(':userId/allocation')
  @UseGuards(JwtAuthGuard)
  getAllocation(@Param('userId') userId: string) {
    return this.portfolioService.getAllocation(userId);
  }
}
