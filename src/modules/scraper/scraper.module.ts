import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScraperService } from './scraper.service';
import { RedisWriterService } from './redis-writer.service';
import { RedisMonitorService } from './redis-monitor.service';
import { StockStoreService } from './stock-store.service';
import { EgxpilotApiService } from './services/egxpilot-api.service';
import { ListScraperProcessor } from './processors/list-scraper.processor';
import { PriceScraperProcessor } from './processors/price-scraper.processor';
import { DetailScraperProcessor } from './processors/detail-scraper.processor';
import { StocksController } from './stocks.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [
    BullModule.registerQueue(
      {
        name: 'list-scraper',
        defaultJobOptions: { removeOnComplete: 3, removeOnFail: 5 },
      },
      {
        name: 'price-scraper',
        defaultJobOptions: { removeOnComplete: 3, removeOnFail: 5 },
      },
      {
        name: 'detail-scraper',
        defaultJobOptions: { removeOnComplete: 3, removeOnFail: 5 },
      },
    ),
  ],
  controllers: [StocksController, HealthController],
  providers: [
    ScraperService,
    RedisWriterService,
    RedisMonitorService,
    StockStoreService,
    EgxpilotApiService,
    ListScraperProcessor,
    PriceScraperProcessor,
    DetailScraperProcessor,
  ],
  exports: [RedisWriterService],
})
export class ScraperModule {}
