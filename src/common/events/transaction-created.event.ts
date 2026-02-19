import { TransactionType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

export class TransactionCreatedEvent {
  constructor(
    public readonly transactionId: string,
    public readonly userId: string,
    public readonly symbol: string,
    public readonly type: TransactionType,
    public readonly quantity: Decimal,
    public readonly price: Decimal,
  ) {}
}
