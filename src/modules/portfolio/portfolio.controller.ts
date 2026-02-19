import { Controller, Get, Param } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';

@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get(':userId')
  getPortfolioSummary(@Param('userId') userId: string) {
    return this.portfolioService.getPortfolioSummary(userId);
  }
}
