import { Module } from '@nestjs/common';
import { GoldController } from './gold.controller';
import { GoldService } from './gold.service';
import { ScraperModule } from '../scraper/scraper.module';

@Module({
  imports: [ScraperModule],
  controllers: [GoldController],
  providers: [GoldService],
  exports: [GoldService],
})
export class GoldModule {}
