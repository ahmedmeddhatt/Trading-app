import { Module } from '@nestjs/common';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { RedisSubscriberService } from './redis-subscriber.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [PricesController],
  providers: [PricesService, RedisSubscriberService],
})
export class PricesModule {}
