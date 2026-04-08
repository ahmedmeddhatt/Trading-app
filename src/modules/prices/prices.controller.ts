import { Controller, Query, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { MessageEvent } from '@nestjs/common';
import { PricesService } from './prices.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('api')
export class PricesController {
  constructor(private readonly pricesService: PricesService) {}

  @Sse('prices')
  @UseGuards(JwtAuthGuard)
  stream(
    @Query('symbol') symbol?: string,
    @Query('mode') mode?: string,
  ): Observable<MessageEvent> {
    if (mode === 'gold') {
      return this.pricesService.getGoldStream(symbol);
    }
    return this.pricesService.getStream(symbol);
  }
}
