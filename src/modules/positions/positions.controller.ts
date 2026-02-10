import { Controller, Get, Param } from '@nestjs/common';
import { PositionsService } from './positions.service';

@Controller('positions')
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Get('user/:userId')
  findByUser(@Param('userId') userId: string) {
    return this.positionsService.findByUser(userId);
  }

  @Get('user/:userId/:symbol')
  findOne(
    @Param('userId') userId: string,
    @Param('symbol') symbol: string,
  ) {
    return this.positionsService.findOne(userId, symbol.toUpperCase());
  }
}
