import { Logger } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { PrismaService } from '../../../database/prisma.service';
import { StockStoreService } from '../stock-store.service';

chromium.use(StealthPlugin());

const JOB_OPTS = { attempts: 3, backoff: { type: 'fixed' as const, delay: 5_000 } };

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function waitForPriceTable(page: import('playwright').Page): Promise<void> {
  const isCloudflare = await page.$('div#cf-wrapper, #challenge-form, .cf-error-type');
  if (isCloudflare) throw new Error('CLOUDFLARE_BLOCKED: EGXpilot is serving a challenge page');

  // Actively wait for JS-rendered table rows to appear (site is a client-side SPA)
  const selectors = ['table tbody tr', '#stocksTable tbody tr', '.price-table tbody tr', '[data-testid="stock-row"]'];
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 30_000 });
      return;
    } catch {
      // try next selector
    }
  }

  const tables = await page.$$eval('table', (tbls) =>
    tbls.map((t) => ({ id: t.id, class: t.className, rows: t.rows.length })),
  );
  throw new Error(`NO_TABLE_FOUND: Tables on page: ${JSON.stringify(tables)}`);
}

@Processor('list-scraper')
export class ListScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ListScraperProcessor.name);

  constructor(
    private readonly stockStore: StockStoreService,
    private readonly prisma: PrismaService,
    @InjectQueue('detail-scraper') private readonly detailQueue: Queue,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    this.logger.log('list-scraper: job started');

    this.logger.log('list-scraper: launching Playwright browser...');
    let browser: import('playwright').Browser;
    try {
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        headless: true,
        args: LAUNCH_ARGS,
      });
      this.logger.log('list-scraper: browser launched successfully');
    } catch (err) {
      this.logger.error(
        { event: 'SCRAPER_FAILED', processor: 'list-scraper', error: (err as Error).message, stack: (err as Error).stack },
        'list-scraper: BROWSER LAUNCH FAILED — is Chromium installed?',
      );
      throw err;
    }

    try {
      const context = await browser.newContext({
        userAgent: USER_AGENT,
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      this.logger.log('list-scraper: navigating to EGXpilot...');
      await page.goto('https://egxpilot.com/stocks.html', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      this.logger.log(`list-scraper: page loaded, title="${await page.title()}"`);
      await waitForPriceTable(page);

      const stocks: { symbol: string; name: string; sector: string }[] = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        const result: { symbol: string; name: string; sector: string }[] = [];
        rows.forEach((tr) => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 4) return;
          const symbol = cells[0]?.textContent?.trim() ?? '';
          const anchor = cells[0]?.querySelector('a');
          const name = anchor?.getAttribute('title') ?? anchor?.textContent?.trim() ?? symbol;
          const sector = cells[7]?.textContent?.trim() ?? '';
          if (symbol) result.push({ symbol, name, sector });
        });
        return result;
      });

      this.logger.log(`list-scraper: scraped ${stocks.length} stocks from EGXpilot`);
      await this.stockStore.saveList(stocks);
      this.logger.log('list-scraper: saved symbol list to Redis market:list');

      await this.prisma.$transaction(
        stocks.map((stock) =>
          this.prisma.stock.upsert({
            where: { symbol: stock.symbol },
            update: { name: stock.name },
            create: {
              symbol: stock.symbol,
              name: stock.name,
              sector: stock.sector || 'Unknown',
              pe: null,
              marketCap: null,
            },
          }),
        ),
      );
      this.logger.log(`list-scraper: upserted ${stocks.length} stocks into DB`);

      await this.detailQueue.add('fetch-sws-large-cap', {}, JOB_OPTS);
      this.logger.log('Enqueued SimplyWallSt large-cap detail scrape');
    } catch (err) {
      this.logger.error(
        { event: 'SCRAPER_FAILED', processor: 'list-scraper', error: (err as Error).message, stack: (err as Error).stack },
        'Scraper job failed',
      );
      throw err;
    } finally {
      await browser!.close();
    }
  }
}
