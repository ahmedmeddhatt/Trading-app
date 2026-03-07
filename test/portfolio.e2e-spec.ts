/**
 * Integration tests for PortfolioController.
 * Tests HTTP layer using NestJS TestingModule + Supertest.
 * All services are mocked — no real DB or Redis.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PortfolioController } from '../src/modules/portfolio/portfolio.controller';
import { PortfolioService } from '../src/modules/portfolio/portfolio.service';
import { JwtAuthGuard } from '../src/modules/auth/guards/jwt-auth.guard';

const mockPortfolioService = {
  getPortfolioSummary: jest.fn(),
  getAnalytics: jest.fn(),
  getStockHistory: jest.fn(),
  getTimeline: jest.fn(),
  getAllocation: jest.fn(),
};

const mockSummary = {
  userId: 'user1',
  totalInvested: '1000.00',
  positionCount: 2,
  positions: [
    { symbol: 'COMI', totalQuantity: '10', averagePrice: '50.00', totalInvested: '500.00' },
  ],
};

const mockAnalytics = {
  positions: [],
  portfolioValue: { totalInvested: '0.00', totalRealized: '0.00', totalUnrealized: '0.00', totalPnL: '0.00', totalPortfolioReturn: null },
  bestPerformer: null,
  worstPerformer: null,
  winRate: null,
};

// Guard that always allows access
class AlwaysAllowGuard {
  canActivate() { return true; }
}

// Guard that always denies
class AlwaysDenyGuard {
  canActivate() { return false; }
}

async function buildApp(allowAuth = true): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [PortfolioController],
    providers: [{ provide: PortfolioService, useValue: mockPortfolioService }],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(allowAuth ? new AlwaysAllowGuard() : new AlwaysDenyGuard())
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe());
  await app.init();
  return app;
}

describe('PortfolioController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPortfolioService.getPortfolioSummary.mockResolvedValue(mockSummary);
    mockPortfolioService.getAnalytics.mockResolvedValue(mockAnalytics);
    mockPortfolioService.getTimeline.mockResolvedValue({ timeline: [] });
    mockPortfolioService.getAllocation.mockResolvedValue({ bySector: [], bySymbol: [] });
    mockPortfolioService.getStockHistory.mockResolvedValue({ symbol: 'COMI', transactions: [], summary: {} });
    app = await buildApp(true);
  });

  afterEach(async () => { await app.close(); });

  describe('GET /portfolio/:userId', () => {
    it('returns 200 with summary data', async () => {
      const res = await request(app.getHttpServer())
        .get('/portfolio/user1')
        .expect(200);

      expect(res.body.totalInvested).toBe('1000.00');
      expect(res.body.positionCount).toBe(2);
    });

    it('calls getPortfolioSummary with the userId param', async () => {
      await request(app.getHttpServer()).get('/portfolio/user-abc').expect(200);
      expect(mockPortfolioService.getPortfolioSummary).toHaveBeenCalledWith('user-abc');
    });
  });

  describe('GET /portfolio/:userId/analytics (JWT required)', () => {
    it('returns 200 with analytics shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/portfolio/user1/analytics')
        .expect(200);

      expect(res.body).toHaveProperty('positions');
      expect(res.body).toHaveProperty('portfolioValue');
    });

    it('returns 401 when JWT guard denies', async () => {
      const deniedApp = await buildApp(false);
      await request(deniedApp.getHttpServer())
        .get('/portfolio/user1/analytics')
        .expect(403); // NestJS returns 403 from canActivate=false
      await deniedApp.close();
    });

    it('returns empty positions for nonexistent user — not 500', async () => {
      mockPortfolioService.getAnalytics.mockResolvedValue({
        ...mockAnalytics,
        positions: [],
      });

      const res = await request(app.getHttpServer())
        .get('/portfolio/nonexistent-user/analytics')
        .expect(200);

      expect(res.body.positions).toHaveLength(0);
    });
  });

  describe('GET /portfolio/:userId/timeline', () => {
    it('returns 200 with timeline array', async () => {
      const res = await request(app.getHttpServer())
        .get('/portfolio/user1/timeline')
        .expect(200);

      expect(res.body).toHaveProperty('timeline');
      expect(Array.isArray(res.body.timeline)).toBe(true);
    });

    it('passes from/to query params to service', async () => {
      await request(app.getHttpServer())
        .get('/portfolio/user1/timeline?from=2026-01-01&to=2026-03-01')
        .expect(200);

      const call = mockPortfolioService.getTimeline.mock.calls[0];
      expect(call[1]).toEqual(new Date('2026-01-01'));
      expect(call[2]).toEqual(new Date('2026-03-01'));
    });
  });

  describe('GET /portfolio/:userId/allocation', () => {
    it('returns 200 with bySector and bySymbol arrays', async () => {
      const res = await request(app.getHttpServer())
        .get('/portfolio/user1/allocation')
        .expect(200);

      expect(res.body).toHaveProperty('bySector');
      expect(res.body).toHaveProperty('bySymbol');
    });
  });

  describe('GET /portfolio/:userId/stock/:symbol/history', () => {
    it('returns 200 with transactions array', async () => {
      const res = await request(app.getHttpServer())
        .get('/portfolio/user1/stock/COMI/history')
        .expect(200);

      expect(res.body).toHaveProperty('symbol', 'COMI');
      expect(res.body).toHaveProperty('transactions');
    });

    it('uppercases the symbol param before calling service', async () => {
      await request(app.getHttpServer())
        .get('/portfolio/user1/stock/comi/history')
        .expect(200);

      expect(mockPortfolioService.getStockHistory).toHaveBeenCalledWith('user1', 'COMI');
    });
  });
});
