import { Transaction } from '@prisma/client';

export class TransactionCreatedEvent {
  constructor(public readonly transaction: Transaction) {}
}
