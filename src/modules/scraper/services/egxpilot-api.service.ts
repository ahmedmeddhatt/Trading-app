import { Injectable, Logger } from '@nestjs/common';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface EgxpilotStock {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  lastUpdate: string;
  recommendation?: string | null;
  signals?: {
    daily: string | null;
    weekly: string | null;
    monthly: string | null;
  };
}

@Injectable()
export class EgxpilotApiService {
  private readonly logger = new Logger(EgxpilotApiService.name);
  private readonly API_URL = 'https://egxpilot.com/api/stocks/all';

  async fetchAllStocks(): Promise<EgxpilotStock[]> {
    try {
      const data = await this.fetchWithRetry(this.API_URL);
      return this.parseAPIResponse(data);
    } catch (directErr) {
      this.logger.warn(`Direct API failed (${(directErr as Error).message}), trying allorigins proxy`);
      const encoded = encodeURIComponent(this.API_URL);
      const wrapper = await this.fetchWithRetry(
        `https://api.allorigins.win/get?url=${encoded}`,
        1,
        20_000,
      );
      const data = JSON.parse(wrapper.contents);
      return this.parseAPIResponse(data);
    }
  }

  private async fetchWithRetry(url: string, attempt = 1, timeoutMs = 15_000): Promise<any> {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://egxpilot.com/stocks.html',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10);
        this.logger.warn(`EGXpilot rate limited — waiting ${retryAfter}s before retry`);
        await sleep(retryAfter * 1000);
        if (attempt <= 3) return this.fetchWithRetry(url, attempt + 1, timeoutMs);
        throw new Error('RATE_LIMITED: max retries exceeded');
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json();
    } catch (err) {
      if (attempt <= 3 && (err as Error).name !== 'AbortError') {
        const delay = Math.min(2 ** attempt * 1000, 30_000);
        this.logger.warn(`Fetch attempt ${attempt} failed — retrying in ${delay}ms`);
        await sleep(delay);
        return this.fetchWithRetry(url, attempt + 1, timeoutMs);
      }
      throw err;
    }
  }

  private parseAPIResponse(data: any): EgxpilotStock[] {
    const arr: any[] = Array.isArray(data) ? data : (data.stocks ?? data.data ?? []);

    if (arr.length > 0) {
      this.logger.log('First stock item: ' + JSON.stringify(arr[0], null, 2));
    }

    return arr
      .map((item: any) => ({
        symbol: item.Symbol ?? item.symbol ?? item.code,
        name: item.StockName ?? item.name ?? item.companyName,
        sector: item.Sector ?? item.sector ?? 'Unknown',
        price: parseFloat(item.LastPrice ?? item.price ?? item.last ?? 0),
        changePercent: parseFloat(item.DailyChange ?? item.changePercent ?? item.pct ?? 0),
        lastUpdate: new Date().toISOString(),
        recommendation: item.Recommendation ?? null,
        signals: {
          daily: item.Daily ?? null,
          weekly: item.Weekly ?? null,
          monthly: item.Monthly ?? null,
        },
      }))
      .filter((s) => s.symbol && s.name);
  }
}
