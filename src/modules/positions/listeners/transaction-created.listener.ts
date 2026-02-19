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
  async handleTransactionCreated(event: TransactionCreatedEvent): Promise<void> {
    this.logger.log(
      `Handling transaction.created: ${event.transaction.id} | ${event.transaction.type} ${event.transaction.quantity} ${event.transaction.symbol}`,
    );

    try {
      await this.positionsService.handleTransaction(event.transaction);
    } catch (error) {
      this.logger.error(
        `Failed to handle transaction ${event.transaction.id}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
