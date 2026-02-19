import { Injectable } from '@nestjs/common';
import { PositionsService } from '../positions/positions.service';
import { Decimal } from '@prisma/client/runtime/library';

export interface PortfolioSummary {
  userId: string;
  totalInvested: string;
  positionCount: number;
  positions: Array<{
    symbol: string;
    totalQuantity: string;
    averagePrice: string;
    totalInvested: string;
  }>;
}

@Injectable()
export class PortfolioService {
  constructor(private readonly positionsService: PositionsService) {}

  async getPortfolioSummary(userId: string): Promise<PortfolioSummary> {
    const positions = await this.positionsService.findByUser(userId);

    const totalInvested = positions.reduce(
      (sum, pos) => sum.add(pos.totalInvested),
      new Decimal(0),
    );

    return {
      userId,
      totalInvested: totalInvested.toFixed(2),
      positionCount: positions.length,
      positions: positions.map((pos) => ({
        symbol: pos.symbol,
        totalQuantity: pos.totalQuantity.toString(),
        averagePrice: pos.averagePrice.toFixed(2),
        totalInvested: pos.totalInvested.toFixed(2),
      })),
    };
  }
}
