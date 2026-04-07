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
        fees: new Decimal(dto.fees ?? 0),
        ...(dto.date ? { createdAt: new Date(dto.date) } : {}),
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
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Soft-delete a transaction and fully recalculate the position + realized gains
   * by replaying all remaining (non-deleted) transactions for that symbol.
   */
  async softDelete(transactionId: string, userId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) throw new Error('Transaction not found');
    if (tx.userId !== userId) throw new Error('Unauthorized');
    if (tx.deletedAt) throw new Error('Transaction already deleted');

    const symbol = tx.symbol;

    await this.prisma.$transaction(async (prisma) => {
      // 1. Soft-delete the transaction
      await prisma.transaction.update({
        where: { id: transactionId },
        data: { deletedAt: new Date() },
      });

      // 2. Soft-delete all realized gains for this symbol (will be recalculated)
      await prisma.realizedGain.updateMany({
        where: { userId, symbol, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // 3. Replay all remaining transactions chronologically
      const remaining = await prisma.transaction.findMany({
        where: { userId, symbol, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      let qty = new Decimal(0);
      let invested = new Decimal(0);
      let avgPrice = new Decimal(0);

      for (const t of remaining) {
        const tQty = new Decimal(t.quantity.toString());
        const tPx = new Decimal(t.price.toString());
        const tFees = new Decimal((t as any).fees?.toString() ?? '0');

        if (t.type === 'BUY') {
          const cost = tQty.mul(tPx).add(tFees);
          qty = qty.add(tQty);
          invested = invested.add(cost);
          avgPrice = qty.isZero() ? new Decimal(0) : invested.div(qty);
        } else {
          // SELL
          const profit = tPx.sub(avgPrice).mul(tQty).sub(tFees);
          await prisma.realizedGain.create({
            data: {
              userId,
              symbol,
              quantity: tQty.toFixed(8),
              sellPrice: tPx.toFixed(8),
              avgPrice: avgPrice.toFixed(8),
              profit: profit.toFixed(8),
              fees: tFees.toFixed(8),
              createdAt: t.createdAt,
            },
          });

          qty = qty.sub(tQty);
          if (qty.isNegative()) qty = new Decimal(0);
          if (qty.isZero()) {
            invested = new Decimal(0);
          } else {
            invested = invested.sub(tQty.mul(avgPrice)).sub(tFees);
          }
          // avgPrice stays the same on sell
        }
      }

      // 4. Update or delete the position
      const position = await prisma.position.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      if (remaining.length === 0) {
        // No transactions left — soft-delete position
        if (position) {
          await prisma.position.update({
            where: { userId_symbol: { userId, symbol } },
            data: { deletedAt: new Date() },
          });
        }
      } else if (position) {
        await prisma.position.update({
          where: { userId_symbol: { userId, symbol } },
          data: {
            totalQuantity: qty.toFixed(8),
            averagePrice: avgPrice.toFixed(8),
            totalInvested: invested.toFixed(8),
            deletedAt: null,
          },
        });
      } else {
        // Position doesn't exist yet but we have transactions — create it
        if (qty.greaterThan(0)) {
          await prisma.position.create({
            data: {
              userId,
              symbol,
              totalQuantity: qty.toFixed(8),
              averagePrice: avgPrice.toFixed(8),
              totalInvested: invested.toFixed(8),
            },
          });
        }
      }
    });

    this.logger.log(`Transaction soft-deleted: ${transactionId} | ${symbol} | position recalculated`);
  }
}
