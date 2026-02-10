import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TransactionCreatedEvent } from '../../../common/events/transaction-created.event';
import { TRANSACTION_CREATED } from '../../../common/constants/event-names';
import { PositionsService } from '../positions.service';

@Injectable()
export class TransactionCreatedListener {
  private readonly logger = new Logger(TransactionCreatedListener.name);

  constructor(private readonly positionsService: PositionsService) {}

  @OnEvent(TRANSACTION_CREATED)
  async handleTransactionCreated(
    event: TransactionCreatedEvent,
  ): Promise<void> {
    this.logger.log(
      `Handling transaction.created: ${event.transactionId} | ${event.type} ${event.quantity} ${event.symbol}`,
    );

    try {
      await this.positionsService.recalculatePosition(
        event.userId,
        event.symbol,
        event.type,
        event.quantity,
        event.price,
      );
    } catch (error) {
      this.logger.error(
        `Failed to recalculate position for transaction ${event.transactionId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
