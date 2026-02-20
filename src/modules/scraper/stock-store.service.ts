import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RedisWriterService } from './redis-writer.service';
import { BaseStock, StockDetails, StockRecord, NewsItem } from './types/stock.types';

@Injectable()
export class StockStoreService {
  private readonly logger = new Logger(StockStoreService.name);
  private readonly outputDir = path.join(process.cwd(), 'output');

  constructor(private readonly redis: RedisWriterService) {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async saveList(stocks: BaseStock[]): Promise<void> {
    await this.redis.set('market:list', JSON.stringify(stocks));
    this.logger.log(`Saved ${stocks.length} stocks to market:list`);
  }

  async getList(): Promise<BaseStock[]> {
    const raw = await this.redis.get('market:list');
    if (!raw) return [];
    try {
      return JSON.parse(raw) as BaseStock[];
    } catch {
      return [];
    }
  }

  async saveDetails(symbol: string, details: StockDetails): Promise<void> {
    await this.redis.set(`market:details:${symbol}`, JSON.stringify(details));
  }

  async getDetails(symbol: string): Promise<StockDetails | null> {
    const raw = await this.redis.get(`market:details:${symbol}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StockDetails;
    } catch {
      return null;
    }
  }

  async savePriceData(symbol: string, price: number, changePercent: number, news: NewsItem[]): Promise<void> {
    await this.redis.set(`market:pricedata:${symbol}`, JSON.stringify({ price, changePercent, news }));
  }

  async getPriceData(symbol: string): Promise<{ price: number; changePercent: number; news: NewsItem[] } | null> {
    const raw = await this.redis.get(`market:pricedata:${symbol}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async savePrevPrice(symbol: string, price: number): Promise<void> {
    await this.redis.set(`market:prev:${symbol}`, String(price));
  }

  async getPrevPrice(symbol: string): Promise<number | null> {
    const raw = await this.redis.get(`market:prev:${symbol}`);
    if (!raw) return null;
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  }

  async buildOutput(): Promise<StockRecord[]> {
    const list = await this.getList();
    const records: StockRecord[] = [];

    for (const stock of list) {
      const details = await this.getDetails(stock.symbol);
      const priceData = await this.getPriceData(stock.symbol);
      const prevPrice = await this.getPrevPrice(stock.symbol);

      const price = priceData?.price ?? details?.price ?? null;
      const changePercent = priceData?.changePercent ?? null;
      const trending = price !== null && prevPrice !== null
        ? Math.abs((price - prevPrice) / prevPrice) > 0.03
        : false;

      records.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        isin: stock.isin,
        price,
        marketCap: details?.marketCap ?? null,
        pe: details?.pe ?? null,
        valuation: details?.valuation ?? null,
        changePercent,
        news: priceData?.news ?? [],
        trending,
      });
    }

    // Sort by marketCap descending (parse numeric portion)
    records.sort((a, b) => {
      const parseNum = (s: string | null) => parseFloat((s ?? '0').replace(/[^0-9.]/g, '')) || 0;
      return parseNum(b.marketCap) - parseNum(a.marketCap);
    });

    return records;
  }

  writeFiles(records: StockRecord[]): void {
    const jsonPath = path.join(this.outputDir, 'stocks.json');
    fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2));

    const headers = 'symbol,name,sector,price,marketCap,pe,valuation,changePercent,trending,newsCount';
    const csvRows = records.map((r) =>
      [
        r.symbol,
        `"${r.name.replace(/"/g, '""')}"`,
        `"${r.sector.replace(/"/g, '""')}"`,
        r.price ?? '',
        r.marketCap ?? '',
        r.pe ?? '',
        r.valuation ?? '',
        r.changePercent ?? '',
        r.trending ? 'true' : 'false',
        r.news.length,
      ].join(','),
    );
    fs.writeFileSync(path.join(this.outputDir, 'stocks.csv'), [headers, ...csvRows].join('\n'));

    this.logger.log(`Output written: ${records.length} records → output/stocks.json + output/stocks.csv`);
  }
}
