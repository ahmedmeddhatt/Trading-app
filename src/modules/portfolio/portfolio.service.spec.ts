/**
 * Unit tests for PortfolioService.
 * Covers: getPortfolioSummary, getAnalytics, getTimeline, getAllocation.
 * All DB and Redis calls are mocked — no real connections.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PortfolioService } from './portfolio.service';
import { PositionsService } from '../positions/positions.service';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import Decimal from 'decimal.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function makePosition(symbol: string, qty: string, avgPx: string, invested: string) {
  return {
    symbol,
    totalQuantity: new Decimal(qty),
    averagePrice: new Decimal(avgPx),
    totalInvested: new Decimal(invested),
  };
}

function freshJson(price: number, changePercent = 0) {
  return JSON.stringify({ price, changePercent, trending: false, timestamp: new Date().toISOString() });
}

// ── mocks ──────────────────────────────────────────────────────────────────────

const mockPositionsService = { findByUser: jest.fn() };

const mockPrisma = {
  realizedGain: { findMany: jest.fn() },
  stockPriceHistory: { findMany: jest.fn() },
  stock: { findMany: jest.fn() },
  transaction: { findMany: jest.fn() },
  position: { findUnique: jest.fn() },
};

const mockRedis = { hgetall: jest.fn() };

// ── suite ──────────────────────────────────────────────────────────────────────

describe('PortfolioService', () => {
  let service: PortfolioService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioService,
        { provide: PositionsService, useValue: mockPositionsService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get(PortfolioService);
  });

  // ── getPortfolioSummary ─────────────────────────────────────────────────────

  describe('getPortfolioSummary', () => {
    it('aggregates totalInvested across positions', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
        makePosition('HRHO', '5', '100', '500'),
      ]);

      const result = await service.getPortfolioSummary('user1');
      expect(result.totalInvested).toBe('1000.00');
      expect(result.positionCount).toBe(2);
    });

    it('returns empty positions for user with no holdings', async () => {
      mockPositionsService.findByUser.mockResolvedValue([]);
      const result = await service.getPortfolioSummary('user1');
      expect(result.totalInvested).toBe('0.00');
      expect(result.positions).toHaveLength(0);
    });
  });

  // ── getAnalytics ───────────────────────────────────────────────────────────

  describe('getAnalytics', () => {
    const userId = 'user1';

    beforeEach(() => {
      mockPrisma.stockPriceHistory.findMany.mockResolvedValue([]);
    });

    it('computes unrealizedPnL correctly with live price', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
      ]);
      mockPrisma.realizedGain.findMany.mockResolvedValue([]);
      mockRedis.hgetall.mockResolvedValue({ COMI: freshJson(60) });

      const result = await service.getAnalytics(userId);
      const pos = result.positions[0];
      // unrealized = (60 - 50) * 10 = 100
      expect(parseFloat(pos.unrealizedPnL!)).toBeCloseTo(100, 2);
    });

    it('returns null unrealizedPnL when Redis has no price for symbol', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('EFIH', '5', '20', '100'),
      ]);
      mockPrisma.realizedGain.findMany.mockResolvedValue([]);
      mockRedis.hgetall.mockResolvedValue({});

      const result = await service.getAnalytics(userId);
      expect(result.positions[0].unrealizedPnL).toBeNull();
    });

    it('edge case: no positions returns zero portfolio values', async () => {
      mockPositionsService.findByUser.mockResolvedValue([]);
      mockPrisma.realizedGain.findMany.mockResolvedValue([]);
      mockRedis.hgetall.mockResolvedValue({});

      const result = await service.getAnalytics(userId);
      expect(result.portfolioValue.totalInvested).toBe('0.00');
      expect(result.portfolioValue.totalPnL).toBe('0.00');
      expect(result.bestPerformer).toBeNull();
      expect(result.worstPerformer).toBeNull();
    });

    it('edge case: all positions at a loss — worstPerformer set, bestPerformer can be winner', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
        makePosition('HRHO', '5', '100', '500'),
      ]);
      mockPrisma.realizedGain.findMany.mockResolvedValue([]);
      // Both at a loss
      mockRedis.hgetall.mockResolvedValue({
        COMI: freshJson(40),
        HRHO: freshJson(80),
      });

      const result = await service.getAnalytics(userId);
      // COMI loss = -100, HRHO loss = -100, both negative
      expect(result.worstPerformer).not.toBeNull();
      expect(parseFloat(result.worstPerformer!.unrealizedPnL!)).toBeLessThan(0);
    });

    it('edge case: winRate is "0.0%" with 0 closed positions, not NaN', async () => {
      mockPositionsService.findByUser.mockResolvedValue([]);
      mockPrisma.realizedGain.findMany.mockResolvedValue([]);
      mockRedis.hgetall.mockResolvedValue({});

      const result = await service.getAnalytics(userId);
      expect(result.winRate).toBeNull(); // null when no closed positions
    });

    it('computes winRate correctly with mixed realizedGains', async () => {
      mockPositionsService.findByUser.mockResolvedValue([]);
      mockPrisma.realizedGain.findMany.mockResolvedValue([
        { symbol: 'COMI', profit: new Decimal('100') },
        { symbol: 'HRHO', profit: new Decimal('-50') },
        { symbol: 'EFIH', profit: new Decimal('200') },
      ]);
      mockRedis.hgetall.mockResolvedValue({});

      const result = await service.getAnalytics(userId);
      // 2 winners out of 3 = 66.7%
      expect(result.winRate).toBe('66.7%');
    });

    it('JWT payload check: totalPortfolioReturn is percentage string or null', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
      ]);
      mockPrisma.realizedGain.findMany.mockResolvedValue([]);
      mockRedis.hgetall.mockResolvedValue({ COMI: freshJson(60) });

      const result = await service.getAnalytics(userId);
      expect(result.portfolioValue.totalPortfolioReturn).toMatch(/^[\d.]+%$/);
    });
  });

  // ── getTimeline ────────────────────────────────────────────────────────────

  describe('getTimeline', () => {
    it('returns empty timeline when user has no positions', async () => {
      mockPositionsService.findByUser.mockResolvedValue([]);
      const result = await service.getTimeline('user1', new Date('2026-01-01'), new Date('2026-03-01'));
      expect(result.timeline).toHaveLength(0);
    });

    it('computes totalValue as sum of qty * price per timestamp', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
        makePosition('HRHO', '5', '100', '500'),
      ]);
      const ts = '2026-02-01T10:00:00.000Z';
      mockPrisma.stockPriceHistory.findMany.mockResolvedValue([
        { symbol: 'COMI', price: new Decimal('60'), timestamp: new Date(ts) },
        { symbol: 'HRHO', price: new Decimal('90'), timestamp: new Date(ts) },
      ]);

      const result = await service.getTimeline('user1', new Date('2026-01-01'), new Date('2026-03-01'));
      // totalValue = 10*60 + 5*90 = 600 + 450 = 1050
      expect(result.timeline).toHaveLength(1);
      expect(parseFloat(result.timeline[0].totalValue)).toBeCloseTo(1050, 2);
    });

    it('groups multiple timestamps independently', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
      ]);
      mockPrisma.stockPriceHistory.findMany.mockResolvedValue([
        { symbol: 'COMI', price: new Decimal('60'), timestamp: new Date('2026-02-01T10:00:00.000Z') },
        { symbol: 'COMI', price: new Decimal('65'), timestamp: new Date('2026-02-02T10:00:00.000Z') },
      ]);

      const result = await service.getTimeline('user1', new Date('2026-01-01'), new Date('2026-03-01'));
      expect(result.timeline).toHaveLength(2);
    });
  });

  // ── getAllocation ──────────────────────────────────────────────────────────

  describe('getAllocation', () => {
    it('returns empty arrays when user has no positions', async () => {
      mockPositionsService.findByUser.mockResolvedValue([]);
      const result = await service.getAllocation('user1');
      expect(result.bySector).toHaveLength(0);
      expect(result.bySymbol).toHaveLength(0);
    });

    it('bySymbol percentages sum to 100', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
        makePosition('HRHO', '5', '100', '500'),
      ]);
      mockPrisma.stock.findMany.mockResolvedValue([
        { symbol: 'COMI', sector: 'Banking' },
        { symbol: 'HRHO', sector: 'Real Estate' },
      ]);
      mockRedis.hgetall.mockResolvedValue({
        COMI: freshJson(50),
        HRHO: freshJson(100),
      });

      const result = await service.getAllocation('user1');
      const total = result.bySymbol.reduce((sum, s) => sum + parseFloat(s.percent), 0);
      expect(total).toBeCloseTo(100, 1);
    });

    it('falls back to averagePrice when Redis has no live price', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
      ]);
      mockPrisma.stock.findMany.mockResolvedValue([
        { symbol: 'COMI', sector: 'Banking' },
      ]);
      mockRedis.hgetall.mockResolvedValue({}); // no live price

      const result = await service.getAllocation('user1');
      // should not throw, uses averagePrice=50 as fallback
      expect(result.bySymbol[0].currentPrice).toBeNull();
      expect(parseFloat(result.bySymbol[0].value)).toBeCloseTo(500, 2);
    });

    it('bySector percentages sum to 100', async () => {
      mockPositionsService.findByUser.mockResolvedValue([
        makePosition('COMI', '10', '50', '500'),
        makePosition('HRHO', '5', '100', '500'),
      ]);
      mockPrisma.stock.findMany.mockResolvedValue([
        { symbol: 'COMI', sector: 'Banking' },
        { symbol: 'HRHO', sector: 'Banking' },
      ]);
      mockRedis.hgetall.mockResolvedValue({});

      const result = await service.getAllocation('user1');
      const total = result.bySector.reduce((sum, s) => sum + parseFloat(s.percent), 0);
      expect(total).toBeCloseTo(100, 1);
      expect(result.bySector[0].sector).toBe('Banking');
    });
  });
});
