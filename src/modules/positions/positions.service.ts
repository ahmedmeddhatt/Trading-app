import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TransactionType, Transaction, Position } from '@prisma/client';
import Decimal from 'decimal.js';

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handleTransaction(transaction: Transaction): Promise<Position> {
    const { userId, symbol, type } = transaction;
    const qty = new Decimal(transaction.quantity.toString());
    const px = new Decimal(transaction.price.toString());

    return this.prisma.$transaction(async (tx) => {
      // Pessimistic lock: lock the row (no-op if row doesn't exist yet)
      await tx.$queryRaw`
        SELECT id FROM positions
        WHERE user_id = ${userId} AND symbol = ${symbol}
        FOR UPDATE
      `;

      const position = await tx.position.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      if (type === TransactionType.BUY) {
        if (!position) {
          const created = await tx.position.create({
            data: {
              userId,
              symbol,
              totalQuantity: qty.toFixed(8),
              averagePrice: px.toFixed(8),
              totalInvested: qty.mul(px).toFixed(8),
            },
          });
          this.logger.log(`Position created: ${userId} | ${symbol} | qty=${qty} avgPrice=${px}`);
          return created;
        }

        const prevQty = new Decimal(position.totalQuantity.toString());
        const prevInv = new Decimal(position.totalInvested.toString());
        const newQty = prevQty.add(qty);
        const newInv = prevInv.add(qty.mul(px));
        const newAvg = newInv.div(newQty);

        const updated = await tx.position.update({
          where: { userId_symbol: { userId, symbol } },
          data: {
            totalQuantity: newQty.toFixed(8),
            totalInvested: newInv.toFixed(8),
            averagePrice: newAvg.toFixed(8),
          },
        });
        this.logger.log(`Position updated (BUY): ${userId} | ${symbol} | qty=${newQty} avgPrice=${newAvg}`);
        return updated;
      }

      // SELL
      if (!position) {
        throw new Error(`Cannot sell ${symbol}: no existing position for user ${userId}`);
      }

      const currQty = new Decimal(position.totalQuantity.toString());
      if (qty.greaterThan(currQty)) {
        throw new Error(`Cannot sell ${qty} of ${symbol}: only ${currQty} held`);
      }

      const avgPx = new Decimal(position.averagePrice.toString());
      const newQty = currQty.sub(qty);
      const newInv = newQty.isZero() ? new Decimal(0) : newQty.mul(avgPx);
      const profit = px.sub(avgPx).mul(qty); // (sellPrice - avgPrice) * sellQty

      const [updated] = await Promise.all([
        tx.position.update({
          where: { userId_symbol: { userId, symbol } },
          data: {
            totalQuantity: newQty.toFixed(8),
            totalInvested: newInv.toFixed(8),
            // avgPrice intentionally unchanged on SELL
          },
        }),
        tx.realizedGain.create({
          data: {
            userId,
            symbol,
            quantity: qty.toFixed(8),
            sellPrice: px.toFixed(8),
            avgPrice: avgPx.toFixed(8),
            profit: profit.toFixed(8),
          },
        }),
      ]);

      this.logger.log(`Position updated (SELL): ${userId} | ${symbol} | qty=${newQty} profit=${profit}`);
      return updated;
    });
  }

  async findByUser(userId: string): Promise<Position[]> {
    return this.prisma.position.findMany({
      where: { userId },
    });
  }

  async findOne(userId: string, symbol: string): Promise<Position | null> {
    return this.prisma.position.findUnique({
      where: { userId_symbol: { userId, symbol } },
    });
  }
}
