import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { PortfolioController } from './portfolio.controller';
import { PositionsModule } from '../positions/positions.module';
import { ScraperModule } from '../scraper/scraper.module';

@Module({
  imports: [PositionsModule, ScraperModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
})
export class PortfolioModule {}
