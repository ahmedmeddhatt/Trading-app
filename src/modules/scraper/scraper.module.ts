import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScraperService } from './scraper.service';
import { RedisWriterService } from './redis-writer.service';
import { StockStoreService } from './stock-store.service';
import { ListScraperProcessor } from './processors/list-scraper.processor';
import { PriceScraperProcessor } from './processors/price-scraper.processor';
import { DetailScraperProcessor } from './processors/detail-scraper.processor';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'list-scraper' },
      { name: 'price-scraper' },
      { name: 'detail-scraper' },
    ),
  ],
  providers: [
    ScraperService,
    RedisWriterService,
    StockStoreService,
    ListScraperProcessor,
    PriceScraperProcessor,
    DetailScraperProcessor,
  ],
})
export class ScraperModule {}
