import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TransactionType, Position } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recalculatePosition(
    userId: string,
    symbol: string,
    type: TransactionType,
    quantity: Decimal,
    price: Decimal,
  ): Promise<Position> {
    return this.prisma.$transaction(async (tx) => {
      let position = await tx.position.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      if (!position) {
        if (type === TransactionType.SELL) {
          throw new Error(
            `Cannot sell ${symbol}: no existing position for user ${userId}`,
          );
        }

        position = await tx.position.create({
          data: {
            userId,
            symbol,
            totalQuantity: quantity,
            averagePrice: price,
            totalInvested: quantity.mul(price),
          },
        });

        this.logger.log(
          `Position created: ${userId} | ${symbol} | qty=${quantity} avgPrice=${price}`,
        );

        return position;
      }

      let newTotalQuantity: Decimal;
      let newTotalInvested: Decimal;
      let newAveragePrice: Decimal;

      if (type === TransactionType.BUY) {
        newTotalQuantity = position.totalQuantity.add(quantity);
        newTotalInvested = position.totalInvested.add(quantity.mul(price));
        newAveragePrice = newTotalInvested.div(newTotalQuantity);
      } else {
        if (quantity.greaterThan(position.totalQuantity)) {
          throw new Error(
            `Cannot sell ${quantity} of ${symbol}: only ${position.totalQuantity} held`,
          );
        }

        newTotalQuantity = position.totalQuantity.sub(quantity);
        newTotalInvested = position.totalInvested.sub(
          quantity.mul(position.averagePrice),
        );
        newAveragePrice = newTotalQuantity.isZero()
          ? new Decimal(0)
          : position.averagePrice;
      }

      const updated = await tx.position.update({
        where: { userId_symbol: { userId, symbol } },
        data: {
          totalQuantity: newTotalQuantity,
          totalInvested: newTotalInvested,
          averagePrice: newAveragePrice,
        },
      });

      this.logger.log(
        `Position updated: ${userId} | ${symbol} | qty=${newTotalQuantity} avgPrice=${newAveragePrice} invested=${newTotalInvested}`,
      );

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
