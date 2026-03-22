import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { RedisWriterService } from './redis-writer.service';
import { RedisMonitorService } from './redis-monitor.service';
import { StockStoreService } from './stock-store.service';
import { StockMetadataService } from './stock-metadata.service';
import { PriceHistoryService } from './price-history.service';
import { TechnicalAnalysisService } from './technical-analysis.service';
import { StocksController } from './stocks.controller';

@Module({
  controllers: [StocksController],
  providers: [
    SchedulerService,
    RedisWriterService,
    RedisMonitorService,
    StockStoreService,
    StockMetadataService,
    PriceHistoryService,
    TechnicalAnalysisService,
  ],
  exports: [RedisWriterService, SchedulerService],
})
export class ScraperModule {}
