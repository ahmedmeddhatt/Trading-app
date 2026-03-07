import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AdminController } from './admin.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'debug-scraper' }),
    AuthModule,
  ],
  controllers: [AdminController],
})
export class AdminModule {}
