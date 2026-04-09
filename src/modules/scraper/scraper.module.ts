import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { RedisWriterService } from './redis-writer.service';
import { RedisMonitorService } from './redis-monitor.service';
import { StockStoreService } from './stock-store.service';
import { StockMetadataService } from './stock-metadata.service';
import { PriceHistoryService } from './price-history.service';
import { GoldPriceHistoryService } from './gold-price-history.service';
import { TechnicalAnalysisService } from './technical-analysis.service';
import { NewsScraperService } from './services/news-scraper.service';
import { GeminiAnalysisService } from './services/gemini-analysis.service';
import { GoldScraperService } from './services/gold-scraper.service';
import { GoldAnalysisService } from './services/gold-analysis.service';

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
    GoldPriceHistoryService,
    TechnicalAnalysisService,
    NewsScraperService,
    GeminiAnalysisService,
    GoldScraperService,
    GoldAnalysisService,
  ],
  exports: [
    RedisWriterService,
    SchedulerService,
    GoldScraperService,
    GoldAnalysisService,
    GoldPriceHistoryService,
  ],
})
export class ScraperModule {}
