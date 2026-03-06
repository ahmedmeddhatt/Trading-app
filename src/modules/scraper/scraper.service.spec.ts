/**
 * Unit tests for ScraperService.
 * Covers: resumeIfPaused, job registration (repeat interval, backoff config).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ScraperService } from './scraper.service';
import { getQueueToken } from '@nestjs/bullmq';

function makeQueueMock() {
  return {
    isPaused: jest.fn().mockResolvedValue(false),
    resume: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  };
}

describe('ScraperService', () => {
  let service: ScraperService;
  let listQueue: ReturnType<typeof makeQueueMock>;
  let priceQueue: ReturnType<typeof makeQueueMock>;
  let archiverQueue: ReturnType<typeof makeQueueMock>;

  beforeEach(async () => {
    jest.clearAllMocks();
    listQueue = makeQueueMock();
    priceQueue = makeQueueMock();
    archiverQueue = makeQueueMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScraperService,
        { provide: getQueueToken('list-scraper'), useValue: listQueue },
        { provide: getQueueToken('price-scraper'), useValue: priceQueue },
        { provide: getQueueToken('archiver'), useValue: archiverQueue },
      ],
    }).compile();

    service = module.get(ScraperService);
  });

  describe('resumeIfPaused', () => {
    it('does NOT call queue.resume() when isPaused() returns false', async () => {
      listQueue.isPaused.mockResolvedValue(false);
      priceQueue.isPaused.mockResolvedValue(false);

      await service.onModuleInit();

      expect(listQueue.resume).not.toHaveBeenCalled();
      expect(priceQueue.resume).not.toHaveBeenCalled();
    });

    it('calls queue.resume() when isPaused() returns true for list-scraper', async () => {
      listQueue.isPaused.mockResolvedValue(true);
      priceQueue.isPaused.mockResolvedValue(false);

      await service.onModuleInit();

      expect(listQueue.resume).toHaveBeenCalledTimes(1);
      expect(priceQueue.resume).not.toHaveBeenCalled();
    });

    it('calls queue.resume() when isPaused() returns true for price-scraper', async () => {
      listQueue.isPaused.mockResolvedValue(false);
      priceQueue.isPaused.mockResolvedValue(true);

      await service.onModuleInit();

      expect(priceQueue.resume).toHaveBeenCalledTimes(1);
    });

    it('resumes both queues if both are paused', async () => {
      listQueue.isPaused.mockResolvedValue(true);
      priceQueue.isPaused.mockResolvedValue(true);

      await service.onModuleInit();

      expect(listQueue.resume).toHaveBeenCalledTimes(1);
      expect(priceQueue.resume).toHaveBeenCalledTimes(1);
    });
  });

  describe('job registration', () => {
    it('registers price-scraper repeat job with 30s interval', async () => {
      await service.onModuleInit();

      const addCalls = priceQueue.add.mock.calls;
      const repeatJob = addCalls.find((c: any[]) => c[2]?.repeat?.every === 30_000);
      expect(repeatJob).toBeDefined();
    });

    it('price-scraper job uses exponential backoff with delay 5000', async () => {
      await service.onModuleInit();

      const addCalls = priceQueue.add.mock.calls;
      // All price-scraper jobs should have exponential backoff
      const jobWithBackoff = addCalls.find((c: any[]) =>
        c[2]?.backoff?.type === 'exponential' && c[2]?.backoff?.delay === 5_000,
      );
      expect(jobWithBackoff).toBeDefined();
    });

    it('list-scraper repeat job has 24h interval', async () => {
      await service.onModuleInit();

      const addCalls = listQueue.add.mock.calls;
      const repeatJob = addCalls.find((c: any[]) => c[2]?.repeat?.every === 24 * 60 * 60 * 1_000);
      expect(repeatJob).toBeDefined();
    });

    it('registers archiver with 1h repeat interval', async () => {
      await service.onModuleInit();

      const addCalls = archiverQueue.add.mock.calls;
      const repeatJob = addCalls.find((c: any[]) => c[2]?.repeat?.every === 60 * 60 * 1_000);
      expect(repeatJob).toBeDefined();
    });

    it('removeOnFail is 50 for price-scraper', async () => {
      await service.onModuleInit();

      const addCalls = priceQueue.add.mock.calls;
      const withRemoveOnFail = addCalls.find((c: any[]) => c[2]?.removeOnFail === 50);
      expect(withRemoveOnFail).toBeDefined();
    });
  });
});
