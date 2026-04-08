import {
  Controller,
  Get,
  Post,
  Body,
  NotFoundException,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { StockStoreService } from './stock-store.service';
import { RedisWriterService } from './redis-writer.service';
import { PrismaService } from '../../database/prisma.service';
import { TechnicalAnalysisService } from './technical-analysis.service';
import { GeminiAnalysisService } from './services/gemini-analysis.service';

@Controller('stocks')
export class StocksController {
  constructor(
    private readonly stockStore: StockStoreService,
    private readonly redis: RedisWriterService,
    private readonly prisma: PrismaService,
    private readonly technicalAnalysis: TechnicalAnalysisService,
    private readonly geminiAnalysis: GeminiAnalysisService,
  ) {}

  @Post('strategy-analysis')
  async strategyAnalysis(
    @Body() body: { strategyId: string; symbols: string[]; horizon?: string },
  ) {
    if (!body.strategyId || !body.symbols?.length) {
      throw new BadRequestException('strategyId and symbols are required');
    }
    if (body.symbols.length > 10) {
      throw new BadRequestException('Maximum 10 symbols per request');
    }
    const validHorizons = ['SPECULATION', 'MID_TERM', 'LONG_TERM'] as const;
    const horizon = validHorizons.includes(body.horizon as any)
      ? (body.horizon as 'SPECULATION' | 'MID_TERM' | 'LONG_TERM')
      : 'MID_TERM';
    const results = await this.geminiAnalysis.analyzeStrategy(
      body.strategyId,
      body.symbols,
      horizon,
    );
    return { results };
  }

  @Get('dashboard')
  async dashboard() {
    const [list, priceMap] = await Promise.all([
      this.stockStore.getList(),
      this.redis.hgetall('market:prices'),
    ]);

    const enriched = list.map((stock) => {
      const raw = priceMap[stock.symbol];
      const p = raw ? JSON.parse(raw) : null;
      return {
        symbol: stock.symbol,
        name: stock.name,

        pe: (stock as any).pe ?? null,
        price: p?.price ?? null,
        changePercent: p?.changePercent ?? null,
        lastUpdate: p?.timestamp
          ? new Date(p.timestamp as number).toISOString()
          : null,
        recommendation: p?.recommendation ?? null,
        signals: p?.signals ?? { daily: null, weekly: null, monthly: null },
      };
    });

    const withPrice = enriched.filter((s) => s.price !== null);

    const hottest = [...withPrice]
      .sort(
        (a, b) =>
          Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0),
      )
      .slice(0, 5);

    const lowest = [...withPrice]
      .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))
      .slice(0, 5);

    const recommended = [...enriched]
      .filter((s) => s.pe !== null)
      .sort((a, b) => (a.pe ?? 0) - (b.pe ?? 0))
      .slice(0, 5);

    // pricesMeta
    const now = Date.now();
    const FRESH_MS = 5 * 60 * 1000;
    let symbolsWithFreshPrice = 0;
    let symbolsWithStalePrice = 0;
    let symbolsWithNoPrice = 0;
    let newestUpdate: number | null = null;
    let oldestUpdate: number | null = null;

    for (const stock of list) {
      const raw = priceMap[stock.symbol];
      if (!raw) {
        symbolsWithNoPrice++;
        continue;
      }
      const p = JSON.parse(raw);
      const ts: number = p?.timestamp ?? 0;
      if (now - ts < FRESH_MS) {
        symbolsWithFreshPrice++;
      } else {
        symbolsWithStalePrice++;
      }
      if (ts) {
        if (newestUpdate === null || ts > newestUpdate) newestUpdate = ts;
        if (oldestUpdate === null || ts < oldestUpdate) oldestUpdate = ts;
      }
    }

    return {
      hottest,
      lowest,
      recommended,
      myStocks: [],
      pricesMeta: {
        symbolsWithFreshPrice,
        symbolsWithStalePrice,
        symbolsWithNoPrice,
        newestUpdate: newestUpdate
          ? new Date(newestUpdate).toISOString()
          : null,
        oldestUpdate: oldestUpdate
          ? new Date(oldestUpdate).toISOString()
          : null,
        totalSymbols: list.length,
      },
    };
  }

  @Get()
  async list(
    @Query('search') search?: string,
    @Query('minPE') minPE?: string,
    @Query('maxPE') maxPE?: string,
    @Query('limit') limit = '50',
    @Query('page') page = '1',
  ) {
    const take = Math.min(parseInt(limit, 10) || 50, 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { symbol: { contains: search.toUpperCase() } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (minPE)
      where.pe = { ...((where.pe as object) ?? {}), gte: parseFloat(minPE) };
    if (maxPE)
      where.pe = { ...((where.pe as object) ?? {}), lte: parseFloat(maxPE) };

    const [stocks, total] = await Promise.all([
      this.prisma.stock.findMany({
        where,
        take,
        skip,
        orderBy: { symbol: 'asc' },
      }),
      this.prisma.stock.count({ where }),
    ]);

    const priceMap = await this.redis.hgetall('market:prices');

    return {
      stocks: stocks.map((s) => {
        const raw = priceMap[s.symbol];
        const p = raw ? JSON.parse(raw) : null;
        return {
          symbol: s.symbol,
          name: s.name,

          pe: s.pe ? parseFloat(s.pe.toString()) : null,
          marketCap: s.marketCap,
          price: p?.price ?? null,
          changePercent: p?.changePercent ?? null,
          lastUpdate: p?.timestamp
            ? new Date(p.timestamp as number).toISOString()
            : null,
          recommendation: p?.recommendation ?? null,
          signals: p?.signals ?? { daily: null, weekly: null, monthly: null },
        };
      }),
      total,
      page: parseInt(page, 10) || 1,
    };
  }

  @Get(':symbol/signal')
  getAISignal(
    @Param('symbol') symbol: string,
    @Query('horizon') horizon?: string,
  ) {
    const validHorizons = ['SPECULATION', 'MID_TERM', 'LONG_TERM'] as const;
    const h = validHorizons.includes(horizon as any)
      ? (horizon as 'SPECULATION' | 'MID_TERM' | 'LONG_TERM')
      : 'MID_TERM';
    return this.geminiAnalysis.analyzeStock(symbol, h);
  }

  @Get(':symbol/technical')
  getTechnicalAnalysis(@Param('symbol') symbol: string) {
    return this.technicalAnalysis.analyze(symbol);
  }

  @Get(':symbol/history')
  async history(
    @Param('symbol') symbol: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const sym = symbol.toUpperCase();
    const fromDate = from ? new Date(from) : new Date(0);
    const toDate = to
      ? new Date(to + 'T23:59:59.999Z')
      : new Date('9999-12-31');

    const rows = await this.prisma.$queryRaw<
      Array<{ price: number; timestamp: Date }>
    >`
      SELECT price::float8, timestamp
      FROM stock_price_history
      WHERE symbol = ${sym}
        AND timestamp >= ${fromDate}
        AND timestamp <= ${toDate}
      ORDER BY timestamp ASC
      LIMIT 500
    `;
    return rows.map((r) => ({
      symbol: sym,
      timestamp: r.timestamp.toISOString(),
      price: r.price,
    }));
  }

  @Get(':symbol')
  async detail(@Param('symbol') symbol: string) {
    const sym = symbol.toUpperCase();
    const [stock, details, priceRaw, historyRows] = await Promise.all([
      this.prisma.stock.findUnique({ where: { symbol: sym } }),
      this.stockStore.getDetails(sym),
      this.redis.hget('market:prices', sym),
      this.prisma.$queryRaw<Array<{ price: number; timestamp: Date }>>`
        SELECT price::float8, timestamp
        FROM stock_price_history
        WHERE symbol = ${sym}
        ORDER BY timestamp ASC
        LIMIT 500
      `,
    ]);

    if (!stock) {
      throw new NotFoundException({
        success: false,
        message: 'Stock not found',
      });
    }

    const p = priceRaw ? JSON.parse(priceRaw) : null;

    // Build price history — include live price if DB history is sparse
    const history = historyRows.map((r) => ({
      timestamp: r.timestamp.toISOString(),
      price: r.price,
    }));
    if (p?.price != null) {
      const liveTs = p.timestamp
        ? new Date(p.timestamp as number).toISOString()
        : new Date().toISOString();
      // Append live price as latest point if not already the last entry
      const lastTs = history.length
        ? history[history.length - 1].timestamp
        : null;
      if (
        !lastTs ||
        new Date(liveTs).getTime() - new Date(lastTs).getTime() > 60_000
      ) {
        history.push({ timestamp: liveTs, price: p.price });
      }
    }

    return {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector,
      pe: stock.pe ? parseFloat(stock.pe.toString()) : (details?.pe ?? null),
      marketCap: stock.marketCap ?? details?.marketCap ?? null,
      price: p?.price ?? null,
      changePercent: p?.changePercent ?? null,
      lastUpdate: p?.timestamp
        ? new Date(p.timestamp as number).toISOString()
        : null,
      recommendation: p?.recommendation ?? null,
      signals: p?.signals ?? { daily: null, weekly: null, monthly: null },
      priceHistory: history,
    };
  }
}
