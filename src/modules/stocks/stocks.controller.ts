import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
import { StocksService } from './stocks.service';
import { StocksQueryDto } from './dto/stocks-query.dto';
import { AuthGuard } from '@nestjs/passport';

/** Optional JWT — attaches user if present, never rejects unauthenticated requests */
class OptionalJwtGuard extends AuthGuard('jwt') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleRequest(_err: any, user: any): any { return user ?? null; }
}

@Controller('stocks')
export class StocksController {
  constructor(private readonly stocksService: StocksService) {}

  @Get('dashboard')
  @UseGuards(OptionalJwtGuard)
  getDashboard(@Request() req: { user?: { id: string } }) {
    return this.stocksService.getDashboard(req.user?.id);
  }

  @Get(':symbol/history')
  getHistory(
    @Param('symbol') symbol: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.stocksService.getHistory(
      symbol.toUpperCase(),
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get(':symbol')
  getBySymbol(@Param('symbol') symbol: string) {
    return this.stocksService.getBySymbol(symbol.toUpperCase());
  }

  @Get()
  search(@Query() query: StocksQueryDto) {
    return this.stocksService.searchStocks(query);
  }
}
