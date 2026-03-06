import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScraperService } from './scraper.service';
import { RedisWriterService } from './redis-writer.service';
import { StockStoreService } from './stock-store.service';
import { StockMetadataService } from './stock-metadata.service';
import { PriceHistoryService } from './price-history.service';
import { ListScraperProcessor } from './processors/list-scraper.processor';
import { PriceScraperProcessor } from './processors/price-scraper.processor';
import { DetailScraperProcessor } from './processors/detail-scraper.processor';
import { ArchiverProcessor } from './processors/archiver.processor';
import { DebugScraperProcessor } from './processors/debug-scraper.processor';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'list-scraper' },
      { name: 'price-scraper' },
      { name: 'detail-scraper' },
      { name: 'archiver' },
      { name: 'debug-scraper' },
    ),
  ],
  providers: [
    ScraperService,
    RedisWriterService,
    StockStoreService,
    StockMetadataService,
    PriceHistoryService,
    ListScraperProcessor,
    PriceScraperProcessor,
    DetailScraperProcessor,
    ArchiverProcessor,
    DebugScraperProcessor,
  ],
})
export class ScraperModule {}
