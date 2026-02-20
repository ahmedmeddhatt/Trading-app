import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { StockStoreService } from '../stock-store.service';
import { StockDetails } from '../types/stock.types';

chromium.use(StealthPlugin());

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

@Processor('detail-scraper')
export class DetailScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(DetailScraperProcessor.name);

  constructor(private readonly stockStore: StockStoreService) {
    super();
  }

  // Single job scrapes the SimplyWallSt large-cap list page for all EG stocks
  async process(_job: Job): Promise<void> {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({ 'User-Agent': ua });

      await page.goto('https://simplywall.st/stocks/eg/market-cap-large', {
        waitUntil: 'networkidle',
        timeout: 40_000,
      });
      await page.waitForSelector('table tbody tr', { timeout: 20_000 });

      const rows: { symbol: string; details: StockDetails }[] = await page.evaluate(() => {
        const result: { symbol: string; details: StockDetails }[] = [];

        document.querySelectorAll('table tbody tr').forEach((tr) => {
          const cells = tr.querySelectorAll('td');
          if (cells.length < 8) return;

          // col[1]: "COMICommercial International Bank Egypt (CIB)E" → extract symbol prefix
          const nameCell = cells[1]?.textContent?.trim() ?? '';
          const symbolMatch = nameCell.match(/^([A-Z0-9]+)/);
          const symbol = symbolMatch?.[1] ?? '';
          if (!symbol) return;

          // col[2]: price like "ج.م138.00"
          const priceRaw = cells[2]?.textContent?.trim().replace(/[^0-9.]/g, '') ?? '';
          const price = parseFloat(priceRaw) || null;

          // col[5]: market cap like "ج.م466.2b"
          const marketCap = cells[5]?.textContent?.trim() ?? null;

          // col[7]: "PB2.0" or "PE12.2"
          const pbPeText = cells[7]?.textContent?.trim() ?? '';
          const pe = pbPeText.startsWith('PE') ? parseFloat(pbPeText.replace('PE', '')) : null;

          // col[10]: sector
          const sector = cells[10]?.textContent?.trim() ?? null;

          result.push({
            symbol,
            details: {
              price: isNaN(price as number) ? null : price,
              marketCap: marketCap || null,
              pe: pe !== null && isNaN(pe) ? null : pe,
              valuation: sector, // use sector as valuation label
            },
          });
        });

        return result;
      });

      this.logger.log(`SimplyWallSt: scraped ${rows.length} large-cap stocks`);

      for (const { symbol, details } of rows) {
        await this.stockStore.saveDetails(symbol, details);
      }

      this.logger.log(`Details saved for ${rows.length} symbols`);
    } catch (err) {
      this.logger.warn(`SimplyWallSt scrape failed: ${(err as Error).message}`);
    } finally {
      await browser.close();
    }
  }
}
