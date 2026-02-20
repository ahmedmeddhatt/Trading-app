import { Logger } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { StockStoreService } from '../stock-store.service';
import { BaseStock } from '../types/stock.types';

chromium.use(StealthPlugin());

const JOB_OPTS = { attempts: 3, backoff: { type: 'fixed' as const, delay: 5_000 } };

@Processor('list-scraper')
export class ListScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ListScraperProcessor.name);

  constructor(
    private readonly stockStore: StockStoreService,
    @InjectQueue('detail-scraper') private readonly detailQueue: Queue,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    this.logger.log('Fetching EGXpilot stock list');
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage();
      await page.goto('https://egxpilot.com/stocks.html', {
        waitUntil: 'networkidle',
        timeout: 45_000,
      });
      await page.waitForSelector('table tbody tr', { timeout: 20_000 });

      const stocks: BaseStock[] = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        const result: { symbol: string; name: string; sector: string }[] = [];

        rows.forEach((tr) => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 4) return;

          const symbol = cells[0]?.textContent?.trim() ?? '';
          // Name may be in anchor title attr; fall back to symbol
          const anchor = cells[0]?.querySelector('a');
          const name = anchor?.getAttribute('title') ?? anchor?.textContent?.trim() ?? symbol;
          const sector = cells[7]?.textContent?.trim() ?? '';

          if (symbol) {
            result.push({ symbol, name, sector });
          }
        });

        return result;
      });

      this.logger.log(`Scraped ${stocks.length} stocks from EGXpilot`);
      await this.stockStore.saveList(stocks);

      // Single SimplyWallSt scrape for large-cap fundamentals
      await this.detailQueue.add('fetch-sws-large-cap', {}, JOB_OPTS);
      this.logger.log('Enqueued SimplyWallSt large-cap detail scrape');
    } catch (err) {
      this.logger.error(`List scrape failed: ${(err as Error).message}`, (err as Error).stack);
      throw err;
    } finally {
      await browser.close();
    }
  }
}
