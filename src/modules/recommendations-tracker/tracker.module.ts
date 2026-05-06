import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminEmailGuard } from './admin-email.guard';
import { TrackerController } from './tracker.controller';
import { TrackerScheduler } from './tracker.scheduler';
import { TrackerService } from './tracker.service';

// Decoupled by design:
//  - imports only AuthModule (for JwtAuthGuard) — Prisma is provided globally
//  - does NOT import ScraperModule, RedisWriterService, or GeminiAnalysisService
//  - reads picks via weekly_picks_log and prices via stock_price_history (both Postgres)
@Module({
  imports: [AuthModule],
  controllers: [TrackerController],
  providers: [TrackerService, TrackerScheduler, AdminEmailGuard],
  exports: [TrackerService],
})
export class RecommendationsTrackerModule {}
