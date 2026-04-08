import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';
import * as cheerio from 'cheerio';

export interface NewsItem {
  title: string;
  source: string;
  date?: string;
}

@Injectable()
export class NewsScraperService {
  private readonly logger = new Logger(NewsScraperService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Get news headlines for a specific stock symbol.
   * Checks Redis cache first (1h TTL).
   */
  async getNewsForStock(symbol: string): Promise<NewsItem[]> {
    const cacheKey = `news:${symbol.toUpperCase()}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const news = await this.scrapeStockNews(symbol);
    if (news.length) {
      await this.redis.setex(cacheKey, 3600, JSON.stringify(news)); // 1h
    }
    return news;
  }

  /**
   * Get general Egyptian market news.
   * Checks Redis cache first (30min TTL).
   */
  async getMarketNews(): Promise<NewsItem[]> {
    const cacheKey = 'news:market';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const news = await this.scrapeMarketNews();
    if (news.length) {
      await this.redis.setex(cacheKey, 1800, JSON.stringify(news)); // 30min
    }
    return news;
  }

  private async scrapeStockNews(symbol: string): Promise<NewsItem[]> {
    const results: NewsItem[] = [];

    // Try Mubasher Egypt for stock-specific news
    try {
      const mubasherNews = await this.scrapeMubasher(symbol);
      results.push(...mubasherNews);
    } catch (err) {
      this.logger.warn(
        `Mubasher scrape failed for ${symbol}: ${(err as Error).message}`,
      );
    }

    // Try Google News search as fallback
    if (results.length < 3) {
      try {
        const googleNews = await this.scrapeGoogleNews(
          `${symbol} EGX بورصة مصر`,
        );
        results.push(...googleNews);
      } catch (err) {
        this.logger.warn(
          `Google News scrape failed for ${symbol}: ${(err as Error).message}`,
        );
      }
    }

    return results.slice(0, 5);
  }

  private async scrapeMarketNews(): Promise<NewsItem[]> {
    const results: NewsItem[] = [];

    try {
      const googleNews = await this.scrapeGoogleNews(
        'البورصة المصرية EGX Egyptian stock market',
      );
      results.push(...googleNews);
    } catch (err) {
      this.logger.warn(`Market news scrape failed: ${(err as Error).message}`);
    }

    return results.slice(0, 10);
  }

  private async scrapeMubasher(symbol: string): Promise<NewsItem[]> {
    const url = `https://www.mubasher.info/markets/EGX/stocks/${symbol}/news`;
    const html = await this.fetchPage(url);
    if (!html) return [];

    const $ = cheerio.load(html);
    const items: NewsItem[] = [];

    $('a[href*="/news/"], .news-item, .article-title, h3 a, h2 a').each(
      (_, el) => {
        const title = $(el).text().trim();
        if (title && title.length > 10 && items.length < 5) {
          items.push({
            title,
            source: 'Mubasher',
            date: new Date().toISOString().split('T')[0],
          });
        }
      },
    );

    return items;
  }

  private async scrapeGoogleNews(query: string): Promise<NewsItem[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ar&gl=EG&ceid=EG:ar`;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return [];

      const xml = await response.text();
      const $ = cheerio.load(xml, { xmlMode: true });
      const items: NewsItem[] = [];

      $('item').each((_, el) => {
        if (items.length >= 10) return false;
        const title = $(el).find('title').text().trim();
        const source = $(el).find('source').text().trim();
        const pubDate = $(el).find('pubDate').text().trim();
        if (title) {
          items.push({
            title,
            source: source || 'Google News',
            date: pubDate
              ? new Date(pubDate).toISOString().split('T')[0]
              : undefined,
          });
        }
      });

      return items;
    } catch {
      return [];
    }
  }

  private async fetchPage(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      return response.text();
    } catch {
      return null;
    }
  }
}
