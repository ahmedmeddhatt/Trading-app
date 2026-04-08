/**
 * BullMQ queue health tests.
 * Covers: queue pause/resume behavior on ScraperService init,
 * job options (removeOnFail, attempts, backoff type).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ScraperService } from './scraper.service';
import { getQueueToken } from '@nestjs/bullmq';

function makeQueueMock(paused = false) {
  return {
    isPaused: jest.fn().mockResolvedValue(paused),
    resume: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getWaitingCount: jest.fn().mockResolvedValue(0),
    getActiveCount: jest.fn().mockResolvedValue(0),
    getFailedCount: jest.fn().mockResolvedValue(0),
  };
}

describe('BullMQ Queue Health', () => {
  let listQueue: ReturnType<typeof makeQueueMock>;
  let priceQueue: ReturnType<typeof makeQueueMock>;
  let archiverQueue: ReturnType<typeof makeQueueMock>;
  let service: ScraperService;

  async function buildModule(listPaused = false, pricePaused = false) {
    jest.clearAllMocks();
    listQueue = makeQueueMock(listPaused);
    priceQueue = makeQueueMock(pricePaused);
    archiverQueue = makeQueueMock(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScraperService,
        { provide: getQueueToken('list-scraper'), useValue: listQueue },
        { provide: getQueueToken('price-scraper'), useValue: priceQueue },
        { provide: getQueueToken('archiver'), useValue: archiverQueue },
      ],
    }).compile();

    service = module.get(ScraperService);
  }

  it('price-scraper queue is NOT resumed when isPaused() returns false', async () => {
    await buildModule(false, false);
    await service.onModuleInit();
    expect(priceQueue.resume).not.toHaveBeenCalled();
  });

  it('price-scraper queue IS resumed when isPaused() returns true', async () => {
    await buildModule(false, true);
    await service.onModuleInit();
    expect(priceQueue.resume).toHaveBeenCalledTimes(1);
  });

  it('list-scraper queue is resumed when paused', async () => {
    await buildModule(true, false);
    await service.onModuleInit();
    expect(listQueue.resume).toHaveBeenCalledTimes(1);
  });

  it('archiver queue is never auto-resumed (not checked in onModuleInit)', async () => {
    await buildModule(false, false);
    await service.onModuleInit();
    // Archiver isPaused is not checked — confirm no resume called
    expect(archiverQueue.resume).not.toHaveBeenCalled();
  });

  describe('job options', () => {
    beforeEach(async () => {
      await buildModule();
      await service.onModuleInit();
    });

    it('price-scraper repeat job uses removeOnFail: 50', () => {
      const allCalls = priceQueue.add.mock.calls;
      const hasRemoveOnFail50 = allCalls.some(
        (c: any[]) => c[2]?.removeOnFail === 50,
      );
      expect(hasRemoveOnFail50).toBe(true);
    });

    it('price-scraper repeat job uses removeOnComplete: 10', () => {
      const allCalls = priceQueue.add.mock.calls;
      const hasRemoveOnComplete = allCalls.some(
        (c: any[]) => c[2]?.removeOnComplete === 10,
      );
      expect(hasRemoveOnComplete).toBe(true);
    });

    it('price-scraper attempts is 3', () => {
      const allCalls = priceQueue.add.mock.calls;
      const hasAttempts3 = allCalls.some((c: any[]) => c[2]?.attempts === 3);
      expect(hasAttempts3).toBe(true);
    });

    it('price-scraper backoff type is exponential', () => {
      const allCalls = priceQueue.add.mock.calls;
      const hasExpBackoff = allCalls.some(
        (c: any[]) => c[2]?.backoff?.type === 'exponential',
      );
      expect(hasExpBackoff).toBe(true);
    });
  });
});
