/**
 * Unit tests for StocksService.
 * Covers: getDashboard (sorting, caching, pricesMeta, dead-price TTL),
 * searchStocks (pagination math, sector filter).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { StocksService } from './stocks.service';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import Decimal from 'decimal.js';

function priceJson(price: number, changePercent: number, ageMs = 0) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  return JSON.stringify({ price, changePercent, trending: false, timestamp: ts });
}

const mockPrisma = {
  stock: { findMany: jest.fn(), count: jest.fn() },
  position: { findMany: jest.fn() },
};

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  hgetall: jest.fn(),
};

describe('StocksService', () => {
  let service: StocksService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StocksService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get(StocksService);
  });

  // ── getDashboard ────────────────────────────────────────────────────────────

  describe('getDashboard', () => {
    beforeEach(() => {
      mockRedis.get.mockResolvedValue(null); // cache miss
      mockRedis.setex.mockResolvedValue(undefined);
      mockPrisma.stock.count.mockResolvedValue(3);
      mockPrisma.stock.findMany.mockResolvedValue([
        { symbol: 'COMI', name: 'CIB', sector: 'Banking', marketCap: '1000', pe: new Decimal('10') },
      ]);
      mockPrisma.position.findMany.mockResolvedValue([]);
    });

    it('returns hottest sorted by |changePercent| descending', async () => {
      mockRedis.hgetall.mockResolvedValue({
        COMI: priceJson(50, 2),
        HRHO: priceJson(100, -8),
        EFIH: priceJson(30, 5),
      });

      const result = await service.getDashboard();
      const hottest = result.hottest as Array<{ symbol: string; changePercent: number }>;
      // Expected order: HRHO(-8=8), EFIH(5), COMI(2)
      expect(hottest[0].symbol).toBe('HRHO');
      expect(hottest[1].symbol).toBe('EFIH');
      expect(hottest[2].symbol).toBe('COMI');
    });

    it('returns lowest sorted by price ascending', async () => {
      mockRedis.hgetall.mockResolvedValue({
        COMI: priceJson(50, 1),
        HRHO: priceJson(100, 1),
        EFIH: priceJson(30, 1),
      });

      const result = await service.getDashboard();
      const lowest = result.lowest as Array<{ symbol: string; price: number }>;
      expect(lowest[0].symbol).toBe('EFIH');
      expect(lowest[1].symbol).toBe('COMI');
      expect(lowest[2].symbol).toBe('HRHO');
    });

    it('uses cached base on second call — prisma findMany called only once', async () => {
      const cachedBase = JSON.stringify({
        hottest: [],
        lowest: [],
        recommended: [],
      });
      // First call: cache miss; second call: cache hit
      mockRedis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(cachedBase);
      mockRedis.hgetall.mockResolvedValue({});

      await service.getDashboard();
      await service.getDashboard();

      // findMany for recommended stocks should only be called once (first call)
      expect(mockPrisma.stock.findMany).toHaveBeenCalledTimes(1);
    });

    it('sets cacheTtl=5 when symbolsWithFreshPrice is 0 (all stale)', async () => {
      const STALE_AGE = 10 * 60 * 1000; // 10 minutes — outside 5min fresh window
      mockRedis.hgetall.mockResolvedValue({
        COMI: priceJson(50, 1, STALE_AGE),
        HRHO: priceJson(100, 2, STALE_AGE),
      });

      await service.getDashboard();

      const setexCall = mockRedis.setex.mock.calls[0];
      expect(setexCall[1]).toBe(5); // TTL should be 5s
    });

    it('sets cacheTtl=30 when at least one fresh price exists', async () => {
      mockRedis.hgetall.mockResolvedValue({
        COMI: priceJson(50, 1, 0), // fresh (age=0)
      });

      await service.getDashboard();

      const setexCall = mockRedis.setex.mock.calls[0];
      expect(setexCall[1]).toBe(30);
    });

    it('pricesMeta: correctly counts fresh, stale, missing', async () => {
      const STALE_AGE = 10 * 60 * 1000;
      mockPrisma.stock.count.mockResolvedValue(4); // 4 symbols in DB
      mockRedis.hgetall.mockResolvedValue({
        COMI: priceJson(50, 1, 0),          // fresh
        HRHO: priceJson(100, 2, STALE_AGE), // stale
        // EFIH missing from Redis → no price
      });

      const result = await service.getDashboard();
      const meta = result.pricesMeta as any;
      expect(meta.symbolsWithFreshPrice).toBe(1);
      expect(meta.symbolsWithStalePrice).toBe(1);
      expect(meta.symbolsWithNoPrice).toBe(2); // 4 total - 1 fresh - 1 stale
    });

    it('myStocks is empty when no userId provided', async () => {
      mockRedis.hgetall.mockResolvedValue({});
      const result = await service.getDashboard();
      expect(result.myStocks).toHaveLength(0);
    });

    it('myStocks populated when userId provided and positions exist', async () => {
      mockPrisma.position.findMany.mockResolvedValue([
        { symbol: 'COMI', totalQuantity: new Decimal('10'), averagePrice: new Decimal('50'), totalInvested: new Decimal('500') },
      ]);
      mockRedis.hgetall.mockResolvedValue({ COMI: priceJson(55, 1) });

      const result = await service.getDashboard('user1');
      expect(result.myStocks).toHaveLength(1);
    });
  });

  // ── searchStocks ───────────────────────────────────────────────────────────

  describe('searchStocks', () => {
    beforeEach(() => {
      mockRedis.hgetall.mockResolvedValue({});
    });

    it('pagination: pages = ceil(total / limit)', async () => {
      mockPrisma.stock.findMany.mockResolvedValue([]);
      mockPrisma.stock.count.mockResolvedValue(45);

      const result = await service.searchStocks({ page: 1, limit: 10 } as any);
      expect(result.pages).toBe(5); // ceil(45/10)
      expect(result.total).toBe(45);
    });

    it('pages = 1 when total < limit', async () => {
      mockPrisma.stock.findMany.mockResolvedValue([]);
      mockPrisma.stock.count.mockResolvedValue(3);

      const result = await service.searchStocks({ page: 1, limit: 20 } as any);
      expect(result.pages).toBe(1);
    });

    it('passes sector filter to prisma WHERE clause', async () => {
      mockPrisma.stock.findMany.mockResolvedValue([]);
      mockPrisma.stock.count.mockResolvedValue(0);

      await service.searchStocks({ sector: 'Banking', page: 1, limit: 20 } as any);

      const whereArg = mockPrisma.stock.findMany.mock.calls[0][0].where;
      expect(whereArg.sector).toEqual({ contains: 'Banking', mode: 'insensitive' });
    });

    it('passes search filter as OR clause on symbol and name', async () => {
      mockPrisma.stock.findMany.mockResolvedValue([]);
      mockPrisma.stock.count.mockResolvedValue(0);

      await service.searchStocks({ search: 'COMI', page: 1, limit: 20 } as any);

      const whereArg = mockPrisma.stock.findMany.mock.calls[0][0].where;
      expect(whereArg.OR).toHaveLength(2);
      expect(whereArg.OR[0].symbol.contains).toBe('COMI');
    });

    it('passes PE range filter when minPE and maxPE provided', async () => {
      mockPrisma.stock.findMany.mockResolvedValue([]);
      mockPrisma.stock.count.mockResolvedValue(0);

      await service.searchStocks({ minPE: 5, maxPE: 20, page: 1, limit: 20 } as any);

      const whereArg = mockPrisma.stock.findMany.mock.calls[0][0].where;
      expect(whereArg.pe).toEqual({ gte: 5, lte: 20 });
    });

    it('enriches results with live prices from Redis', async () => {
      mockPrisma.stock.findMany.mockResolvedValue([
        { symbol: 'COMI', name: 'CIB', sector: 'Banking', marketCap: '1000', pe: new Decimal('10') },
      ]);
      mockPrisma.stock.count.mockResolvedValue(1);
      mockRedis.hgetall.mockResolvedValue({ COMI: priceJson(55, 2) });

      const result = await service.searchStocks({ page: 1, limit: 20 } as any);
      expect(result.data[0].price).toBe(55);
      expect(result.data[0].changePercent).toBe(2);
    });
  });
});
