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
  getAnalytics(
    @Param('userId') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    return this.portfolioService.getAnalytics(userId, fromDate, toDate);
  }

  @Get(':userId/transactions')
  @UseGuards(JwtAuthGuard)
  getTransactionsMaster(
    @Param('userId') userId: string,
    @Query('symbol') symbol?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.portfolioService.getTransactionsMaster(userId, {
      symbol,
      type,
      from,
      to,
    });
  }

  @Get(':userId/transactions/:id/detail')
  @UseGuards(JwtAuthGuard)
  getTransactionDetail(
    @Param('userId') userId: string,
    @Param('id') id: string,
  ) {
    return this.portfolioService.getTransactionDetail(userId, id);
  }

  @Get(':userId/positions/:symbol/detail')
  @UseGuards(JwtAuthGuard)
  getPositionDetail(
    @Param('userId') userId: string,
    @Param('symbol') symbol: string,
  ) {
    return this.portfolioService.getPositionDetail(
      userId,
      symbol.toUpperCase(),
    );
  }

  @Get(':userId/risk')
  @UseGuards(JwtAuthGuard)
  getRiskAnalytics(
    @Param('userId') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    return this.portfolioService.getRiskAnalytics(userId, fromDate, toDate);
  }

  @Get(':userId/pnl-calendar')
  @UseGuards(JwtAuthGuard)
  getPnLCalendar(
    @Param('userId') userId: string,
    @Query('year') year?: string,
  ) {
    return this.portfolioService.getPnLCalendar(
      userId,
      year ? parseInt(year) : new Date().getFullYear(),
    );
  }

  @Get(':userId/closed-trades')
  @UseGuards(JwtAuthGuard)
  getClosedTrades(@Param('userId') userId: string) {
    return this.portfolioService.getClosedTrades(userId);
  }

  @Get(':userId/insights')
  @UseGuards(JwtAuthGuard)
  getInsights(@Param('userId') userId: string) {
    return this.portfolioService.getInsights(userId);
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
    const fromDate = from
      ? new Date(from)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    return this.portfolioService.getTimeline(userId, fromDate, toDate);
  }

  @Get(':userId/allocation')
  @UseGuards(JwtAuthGuard)
  getAllocation(@Param('userId') userId: string) {
    return this.portfolioService.getAllocation(userId);
  }

  @Get(':userId/closed-positions')
  @UseGuards(JwtAuthGuard)
  getClosedPositions(
    @Param('userId') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    return this.portfolioService.getClosedPositions(userId, fromDate, toDate);
  }

  @Get(':userId/realized-gains')
  @UseGuards(JwtAuthGuard)
  getRealizedGainsList(
    @Param('userId') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    return this.portfolioService.getRealizedGainsList(userId, fromDate, toDate);
  }
}
