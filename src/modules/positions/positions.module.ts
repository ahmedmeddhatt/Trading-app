import { Module } from '@nestjs/common';
import { PositionsService } from './positions.service';
import { PositionsController } from './positions.controller';
import { TransactionCreatedListener } from './listeners/transaction-created.listener';

@Module({
  controllers: [PositionsController],
  providers: [PositionsService, TransactionCreatedListener],
  exports: [PositionsService],
})
export class PositionsModule {}
