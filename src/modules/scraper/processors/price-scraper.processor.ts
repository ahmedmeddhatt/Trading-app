import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { StockStoreService } from '../stock-store.service';
import { RedisWriterService } from '../redis-writer.service';
import { PRICES_UPDATED } from '../../../common/constants/event-names';
chromium.use(StealthPlugin());

@Processor('price-scraper')
export class PriceScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(PriceScraperProcessor.name);

  constructor(
    private readonly stockStore: StockStoreService,
    private readonly redisWriter: RedisWriterService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const existingList = await this.stockStore.getList();
    if (existingList.length === 0) {
      this.logger.warn('No stock list in Redis — skipping price scrape (waiting for list-scraper)');
      return;
    }

    this.logger.log('Re-scraping EGXpilot for live prices');
    const browser = await chromium.launch({ headless: true });
    let updated = 0;

    try {
      const page = await browser.newPage();
      await page.goto('https://egxpilot.com/stocks.html', {
        waitUntil: 'networkidle',
        timeout: 45_000,
      });
      await page.waitForSelector('table tbody tr', { timeout: 20_000 });

      // Scrape all prices in one page load
      const priceMap: Record<string, { price: number; changePercent: number }> = await page.evaluate(() => {
        const result: Record<string, { price: number; changePercent: number }> = {};
        document.querySelectorAll('table tbody tr').forEach((tr) => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 3) return;
          const symbol = cells[0]?.textContent?.trim() ?? '';
          const price = parseFloat((cells[1]?.textContent?.trim() ?? '').replace(/,/g, ''));
          const changePercent = parseFloat((cells[2]?.textContent?.trim() ?? '').replace('%', ''));
          if (symbol && !isNaN(price)) {
            result[symbol] = { price, changePercent: isNaN(changePercent) ? 0 : changePercent };
          }
        });
        return result;
      });

      const timestamp = Date.now();

      for (const [symbol, data] of Object.entries(priceMap)) {
        const prevPrice = await this.stockStore.getPrevPrice(symbol);
        const trending = prevPrice !== null ? Math.abs((data.price - prevPrice) / prevPrice) > 0.03 : false;

        const payload = JSON.stringify({ price: data.price, changePercent: data.changePercent, trending, timestamp });
        await this.redisWriter.hset(symbol, payload);
        await this.redisWriter.publish('prices', JSON.stringify({ symbol, price: data.price, timestamp }));
        await this.stockStore.savePriceData(symbol, data.price, data.changePercent, []);
        await this.stockStore.savePrevPrice(symbol, data.price);
        updated++;
      }
    } finally {
      await browser.close();
    }

    const records = await this.stockStore.buildOutput();
    this.stockStore.writeFiles(records);

    this.eventEmitter.emit(PRICES_UPDATED, { count: updated, total: existingList.length });
    this.logger.log(`Price update complete — ${updated} symbols updated`);
  }
}
