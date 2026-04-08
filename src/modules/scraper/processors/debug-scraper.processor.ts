import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';

chromium.use(StealthPlugin());

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

export interface DebugResult {
  url: string;
  pageLoaded: boolean;
  cloudflareBlocked: boolean;
  tables: { id: string; class: string; rows: number }[];
  knownSelectorHits: Record<string, boolean>;
  screenshotPath: string | null;
  htmlLength: number;
  error: string | null;
}

@Processor('debug-scraper')
export class DebugScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(DebugScraperProcessor.name);

  async process(_job: Job): Promise<DebugResult> {
    const url = 'https://egxpilot.com/stocks.html';
    const screenshotPath = '/tmp/egxpilot-debug.png';
    const result: DebugResult = {
      url,
      pageLoaded: false,
      cloudflareBlocked: false,
      tables: [],
      knownSelectorHits: {},
      screenshotPath: null,
      htmlLength: 0,
      error: null,
    };

    const browser = await chromium.launch({
      headless: true,
      args: LAUNCH_ARGS,
    });
    try {
      const context = await browser.newContext({
        userAgent: USER_AGENT,
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        viewport: { width: 1280, height: 800 },
      });

      const page = await context.newPage();

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      result.pageLoaded = true;

      try {
        await page.waitForLoadState('networkidle', { timeout: 15_000 });
      } catch {
        this.logger.warn(
          'networkidle timed out — continuing with partial page',
        );
      }

      // Cloudflare check
      const cf = await page.$(
        'div#cf-wrapper, #challenge-form, .cf-error-type',
      );
      result.cloudflareBlocked = !!cf;

      // Enumerate all tables
      result.tables = await page.$$eval('table', (tbls) =>
        tbls.map((t) => ({
          id: t.id,
          class: t.className,
          rows: t.rows.length,
        })),
      );

      // Check known selectors
      const selectors = [
        'table tbody tr',
        '#stocksTable tbody tr',
        '.price-table tbody tr',
        '[data-testid="stock-row"]',
        'tbody tr',
        'tr td',
      ];
      for (const sel of selectors) {
        result.knownSelectorHits[sel] = !!(await page.$(sel));
      }

      // Screenshot
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPath = fs.existsSync(screenshotPath)
        ? screenshotPath
        : null;

      // HTML dump at debug level
      const html = await page.content();
      result.htmlLength = html.length;
      this.logger.debug({
        event: 'DEBUG_PAGE_HTML',
        htmlLength: html.length,
        html: html.slice(0, 5000),
      });
    } catch (err) {
      result.error = (err as Error).message;
      this.logger.error({ event: 'DEBUG_SCRAPER_ERROR', error: result.error });
    } finally {
      await browser.close();
    }

    this.logger.log({
      event: 'DEBUG_SCRAPER_RESULT',
      ...result,
    });

    return result;
  }
}
