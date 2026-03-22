import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AuthModule } from '../auth/auth.module';
import { ScraperModule } from '../scraper/scraper.module';

@Module({
  imports: [AuthModule, ScraperModule],
  controllers: [AdminController],
})
export class AdminModule {}
