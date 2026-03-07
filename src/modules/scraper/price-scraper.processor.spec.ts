/**
 * Unit tests for PriceScraperProcessor.
 * Playwright is fully mocked — no real browser launched.
 * Covers: happy path (prices written to Redis), Cloudflare detection,
 * NO_TABLE_FOUND error, ISO timestamp format in stored JSON.
 */

// ── mock playwright-extra and stealth plugin before any imports ────────────────

const mockPage = {
  goto: jest.fn().mockResolvedValue(undefined),
  waitForLoadState: jest.fn().mockResolvedValue(undefined),
  $: jest.fn().mockResolvedValue(null),
  $$eval: jest.fn().mockResolvedValue([]),
  evaluate: jest.fn(),
  content: jest.fn().mockResolvedValue('<html></html>'),
  screenshot: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
};

const mockContext = {
  newPage: jest.fn().mockResolvedValue(mockPage),
};

const mockBrowser = {
  newContext: jest.fn().mockResolvedValue(mockContext),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('playwright-extra', () => ({
  chromium: {
    use: jest.fn(),
    launch: jest.fn().mockResolvedValue(mockBrowser),
  },
}));

jest.mock('puppeteer-extra-plugin-stealth', () => jest.fn(() => ({})));

// ── now import processor ───────────────────────────────────────────────────────

import { Test, TestingModule } from '@nestjs/testing';
import { PriceScraperProcessor } from './processors/price-scraper.processor';
import { StockStoreService } from './stock-store.service';
import { RedisWriterService } from './redis-writer.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

const mockStockStore = {
  getList: jest.fn(),
  getPrevPrice: jest.fn(),
  savePriceData: jest.fn(),
  savePrevPrice: jest.fn(),
  buildOutput: jest.fn(),
  writeFiles: jest.fn(),
};

const mockRedisWriter = {
  hset: jest.fn(),
  publish: jest.fn(),
};

const mockEventEmitter = { emit: jest.fn() };

// Fake BullMQ Job
const fakeJob = { id: 'test-job', data: {} } as any;

describe('PriceScraperProcessor', () => {
  let processor: PriceScraperProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset page mock defaults
    mockPage.$.mockResolvedValue(null);
    mockPage.$$eval.mockResolvedValue([]);
    mockPage.waitForLoadState.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PriceScraperProcessor,
        { provide: StockStoreService, useValue: mockStockStore },
        { provide: RedisWriterService, useValue: mockRedisWriter },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    processor = module.get(PriceScraperProcessor);
  });

  it('skips scrape when stock list is empty', async () => {
    mockStockStore.getList.mockResolvedValue([]);
    await processor.process(fakeJob);
    expect(mockBrowser.newContext).not.toHaveBeenCalled();
  });

  describe('happy path — 5 price rows scraped', () => {
    const fiveStocks = [
      { symbol: 'COMI' }, { symbol: 'HRHO' }, { symbol: 'EFIH' },
      { symbol: 'EKHO' }, { symbol: 'ABUK' },
    ];

    beforeEach(() => {
      mockStockStore.getList.mockResolvedValue(fiveStocks);
      mockStockStore.getPrevPrice.mockResolvedValue(null);
      mockStockStore.buildOutput.mockResolvedValue([]);
      mockStockStore.savePriceData.mockResolvedValue(undefined);
      mockStockStore.savePrevPrice.mockResolvedValue(undefined);

      // Mock page.$ returning a real element for 'table tbody tr' selector
      mockPage.$.mockImplementation((selector: string) => {
        if (selector === 'table tbody tr') return Promise.resolve({});
        return Promise.resolve(null);
      });

      // Mock evaluate to return 5 price rows
      mockPage.evaluate.mockResolvedValue({
        COMI: { price: 55.5, changePercent: 1.2 },
        HRHO: { price: 120.0, changePercent: -0.5 },
        EFIH: { price: 30.0, changePercent: 2.1 },
        EKHO: { price: 80.0, changePercent: 0.3 },
        ABUK: { price: 45.0, changePercent: -1.8 },
      });
    });

    it('calls Redis hset for each symbol', async () => {
      await processor.process(fakeJob);
      expect(mockRedisWriter.hset).toHaveBeenCalledTimes(5);
    });

    it('stores correct symbol key in hset calls', async () => {
      await processor.process(fakeJob);
      const hsetSymbols = mockRedisWriter.hset.mock.calls.map((c: any[]) => c[0]);
      expect(hsetSymbols).toContain('COMI');
      expect(hsetSymbols).toContain('HRHO');
    });

    it('stored JSON includes price, changePercent, and trending fields', async () => {
      await processor.process(fakeJob);
      const comiCall = mockRedisWriter.hset.mock.calls.find((c: any[]) => c[0] === 'COMI');
      const payload = JSON.parse(comiCall[1]);
      expect(payload.price).toBe(55.5);
      expect(payload.changePercent).toBe(1.2);
      expect(payload).toHaveProperty('trending');
    });

    it('timestamp in stored JSON is a valid ISO 8601 string', async () => {
      await processor.process(fakeJob);
      const anyCall = mockRedisWriter.hset.mock.calls[0];
      const payload = JSON.parse(anyCall[1]);
      expect(() => new Date(payload.timestamp)).not.toThrow();
      expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
    });

    it('emits PRICES_UPDATED event with correct count', async () => {
      await processor.process(fakeJob);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ count: 5 }),
      );
    });

    it('publishes to prices channel for each symbol', async () => {
      await processor.process(fakeJob);
      expect(mockRedisWriter.publish).toHaveBeenCalledTimes(5);
    });

    it('closes browser even on success', async () => {
      await processor.process(fakeJob);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cloudflare detection', () => {
    beforeEach(() => {
      mockStockStore.getList.mockResolvedValue([{ symbol: 'COMI' }]);
    });

    it('throws CLOUDFLARE_BLOCKED when cf-wrapper element found', async () => {
      // page.$ returns truthy for cf-wrapper selector
      mockPage.$.mockImplementation((selector: string) => {
        if (selector === 'div#cf-wrapper, #challenge-form, .cf-error-type') {
          return Promise.resolve({ id: 'cf-wrapper' });
        }
        return Promise.resolve(null);
      });

      await expect(processor.process(fakeJob)).rejects.toThrow('CLOUDFLARE_BLOCKED');
    });

    it('closes browser on Cloudflare error', async () => {
      mockPage.$.mockImplementation((selector: string) => {
        if (selector.includes('cf-wrapper')) return Promise.resolve({});
        return Promise.resolve(null);
      });

      await expect(processor.process(fakeJob)).rejects.toThrow();
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('NO_TABLE_FOUND', () => {
    beforeEach(() => {
      mockStockStore.getList.mockResolvedValue([{ symbol: 'COMI' }]);
      // All selectors return null (no table found)
      mockPage.$.mockResolvedValue(null);
      mockPage.$$eval.mockResolvedValue([
        { id: 'data-grid', class: 'react-table', rows: 0 },
      ]);
    });

    it('throws NO_TABLE_FOUND when no known selector matches', async () => {
      await expect(processor.process(fakeJob)).rejects.toThrow('NO_TABLE_FOUND');
    });

    it('includes tables enumeration in NO_TABLE_FOUND error message', async () => {
      let errorMsg = '';
      try {
        await processor.process(fakeJob);
      } catch (e) {
        errorMsg = (e as Error).message;
      }
      expect(errorMsg).toContain('data-grid');
    });

    it('closes browser on NO_TABLE_FOUND', async () => {
      await expect(processor.process(fakeJob)).rejects.toThrow();
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });
  });
});
