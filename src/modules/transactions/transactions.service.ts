import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { CreateTransactionDto } from '../../common/dto/create-transaction.dto';
import { TransactionCreatedEvent } from '../../common/events/transaction-created.event';
import { TRANSACTION_CREATED } from '../../common/constants/event-names';
import { Transaction } from '@prisma/client';
import Decimal from 'decimal.js';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateTransactionDto): Promise<Transaction> {
    const transaction = await this.prisma.transaction.create({
      data: {
        userId: dto.userId,
        symbol: dto.symbol.toUpperCase(),
        type: dto.type,
        quantity: new Decimal(dto.quantity),
        price: new Decimal(dto.price),
      },
    });

    const event = new TransactionCreatedEvent(transaction);

    this.logger.log(
      `Transaction created: ${transaction.id} | ${dto.type} ${dto.quantity} ${dto.symbol} @ ${dto.price}`,
    );

    this.eventEmitter.emit(TRANSACTION_CREATED, event);

    return transaction;
  }

  async findByUser(userId: string): Promise<Transaction[]> {
    return this.prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
