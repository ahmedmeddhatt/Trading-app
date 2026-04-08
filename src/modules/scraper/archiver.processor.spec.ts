/**
 * Unit tests for ArchiverProcessor.
 * Covers: PRICES_DEAD alert, market hours guard, healthy/dead price scenarios.
 * No real Redis or DB connections.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ArchiverProcessor } from './processors/archiver.processor';
import { PriceHistoryService } from './price-history.service';
import { RedisWriterService } from './redis-writer.service';

const mockPriceHistory = {
  createDailySnapshot: jest.fn().mockResolvedValue(undefined),
};

const mockRedisWriter = {
  hgetall: jest.fn(),
};

const fakeJob = { id: 'test-job', data: {} } as any;

function makeRawPrices(ageMs: number, count = 3): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const symbol = `SYM${i}`;
    result[symbol] = JSON.stringify({
      price: 50 + i,
      changePercent: 1,
      timestamp: new Date(Date.now() - ageMs).toISOString(),
    });
  }
  return result;
}

describe('ArchiverProcessor', () => {
  let processor: ArchiverProcessor;
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArchiverProcessor,
        { provide: PriceHistoryService, useValue: mockPriceHistory },
        { provide: RedisWriterService, useValue: mockRedisWriter },
      ],
    }).compile();

    processor = module.get(ArchiverProcessor);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loggerErrorSpy = jest.spyOn((processor as any).logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  describe('checkPriceHealth — PRICES_DEAD alert', () => {
    it('logs PRICES_DEAD error when all prices are older than 5 min', async () => {
      const TEN_MIN = 10 * 60 * 1000;
      mockRedisWriter.hgetall.mockResolvedValue(makeRawPrices(TEN_MIN, 3));

      // Force market hours check to skip archival
      jest.spyOn(processor as any, 'isMarketHours').mockReturnValue(false);

      await processor.process(fakeJob);

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'PRICES_DEAD' }),
      );
    });

    it('does NOT log PRICES_DEAD when at least one price is fresh', async () => {
      mockRedisWriter.hgetall.mockResolvedValue(makeRawPrices(0, 3)); // all fresh

      jest.spyOn(processor as any, 'isMarketHours').mockReturnValue(false);

      await processor.process(fakeJob);

      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    it('skips health check log when no prices in Redis at all', async () => {
      mockRedisWriter.hgetall.mockResolvedValue({});

      jest.spyOn(processor as any, 'isMarketHours').mockReturnValue(false);

      await processor.process(fakeJob);
      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    it('PRICES_DEAD log includes symbolsTotal and oldestUpdate fields', async () => {
      const STALE_AGE = 20 * 60 * 1000;
      mockRedisWriter.hgetall.mockResolvedValue(makeRawPrices(STALE_AGE, 5));

      jest.spyOn(processor as any, 'isMarketHours').mockReturnValue(false);

      await processor.process(fakeJob);

      const errorArg = loggerErrorSpy.mock.calls[0][0];
      expect(errorArg.symbolsTotal).toBe(5);
      expect(errorArg.oldestUpdate).toBeDefined();
    });
  });

  describe('market hours guard', () => {
    it('skips archival when outside market hours', async () => {
      mockRedisWriter.hgetall.mockResolvedValue(makeRawPrices(0));
      jest.spyOn(processor as any, 'isMarketHours').mockReturnValue(false);

      await processor.process(fakeJob);

      expect(mockPriceHistory.createDailySnapshot).not.toHaveBeenCalled();
    });

    it('runs archival when inside market hours', async () => {
      mockRedisWriter.hgetall.mockResolvedValue(makeRawPrices(0));
      jest.spyOn(processor as any, 'isMarketHours').mockReturnValue(true);

      await processor.process(fakeJob);

      expect(mockPriceHistory.createDailySnapshot).toHaveBeenCalledTimes(1);
    });
  });
});
