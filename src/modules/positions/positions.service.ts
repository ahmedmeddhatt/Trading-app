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
    // fees exists after migration; fallback to 0 for safety
    const fees = new Decimal((transaction as any).fees?.toString() ?? '0');

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

      // Treat soft-deleted positions as non-existent for new transactions
      const activePosition = position && !position.deletedAt ? position : null;

      if (type === TransactionType.BUY) {
        // Include fees in totalInvested so averagePrice reflects true cost basis
        const buyCost = qty.mul(px).add(fees);
        if (!activePosition) {
          const newAvg = buyCost.div(qty);
          // If a soft-deleted position exists, revive it instead of creating a new one
          if (position) {
            const revived = await tx.position.update({
              where: { userId_symbol: { userId, symbol } },
              data: {
                totalQuantity: qty.toFixed(8),
                averagePrice: newAvg.toFixed(8),
                totalInvested: buyCost.toFixed(8),
                deletedAt: null,
              },
            });
            this.logger.log(
              `Position revived: ${userId} | ${symbol} | qty=${qty} avgPrice=${newAvg}`,
            );
            return revived;
          }
          const created = await tx.position.create({
            data: {
              userId,
              symbol,
              totalQuantity: qty.toFixed(8),
              averagePrice: newAvg.toFixed(8),
              totalInvested: buyCost.toFixed(8),
            },
          });
          this.logger.log(
            `Position created: ${userId} | ${symbol} | qty=${qty} avgPrice=${newAvg}`,
          );
          return created;
        }

        const prevQty = new Decimal(activePosition.totalQuantity.toString());
        const prevInv = new Decimal(activePosition.totalInvested.toString());
        const newQty = prevQty.add(qty);
        const newInv = prevInv.add(buyCost);
        const newAvg = newInv.div(newQty);

        const updated = await tx.position.update({
          where: { userId_symbol: { userId, symbol } },
          data: {
            totalQuantity: newQty.toFixed(8),
            totalInvested: newInv.toFixed(8),
            averagePrice: newAvg.toFixed(8),
          },
        });
        this.logger.log(
          `Position updated (BUY): ${userId} | ${symbol} | qty=${newQty} avgPrice=${newAvg}`,
        );
        return updated;
      }

      // SELL
      if (!activePosition) {
        throw new Error(
          `Cannot sell ${symbol}: no existing position for user ${userId}`,
        );
      }

      const currQty = new Decimal(activePosition.totalQuantity.toString());
      if (qty.greaterThan(currQty)) {
        throw new Error(
          `Cannot sell ${qty} of ${symbol}: only ${currQty} held`,
        );
      }

      const avgPx = new Decimal(activePosition.averagePrice.toString());
      const prevInv = new Decimal(activePosition.totalInvested.toString());
      const newQty = currQty.sub(qty);
      const newInv = newQty.isZero()
        ? new Decimal(0)
        : prevInv.sub(qty.mul(avgPx)).sub(fees);
      const profit = px.sub(avgPx).mul(qty).sub(fees);

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
            fees: fees.toFixed(8),
          },
        }),
      ]);

      this.logger.log(
        `Position updated (SELL): ${userId} | ${symbol} | qty=${newQty} profit=${profit}`,
      );
      return updated;
    });
  }

  async findByUser(userId: string, assetType?: string): Promise<Position[]> {
    const where: Record<string, unknown> = { userId, deletedAt: null };
    if (assetType) where.assetType = assetType;
    const positions = await this.prisma.position.findMany({ where });
    return positions.filter(
      (p) => !new Decimal(p.totalQuantity.toString()).isZero(),
    );
  }

  async findOne(userId: string, symbol: string): Promise<Position | null> {
    return this.prisma.position.findFirst({
      where: { userId, symbol, deletedAt: null },
    });
  }
}
