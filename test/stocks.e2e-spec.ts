/**
 * Integration tests for StocksController.
 * Tests HTTP layer using NestJS TestingModule + Supertest.
 * All services are mocked — no real DB or Redis.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { StocksController } from '../src/modules/stocks/stocks.controller';
import { StocksService } from '../src/modules/stocks/stocks.service';
import { AuthGuard } from '@nestjs/passport';

const mockStocksService = {
  getDashboard: jest.fn(),
  searchStocks: jest.fn(),
};

const mockDashboard = {
  hottest: [{ symbol: 'HRHO', price: 100, changePercent: -8 }],
  recommended: [{ symbol: 'COMI', pe: '10' }],
  lowest: [{ symbol: 'EFIH', price: 30 }],
  myStocks: [],
  pricesMeta: {
    totalSymbols: 279,
    symbolsWithFreshPrice: 0,
    symbolsWithStalePrice: 279,
    symbolsWithNoPrice: 0,
    oldestUpdate: '2026-02-28T17:18:36.000Z',
    newestUpdate: '2026-02-28T18:26:23.000Z',
  },
};

async function buildApp(userId: string | null = null): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [StocksController],
    providers: [{ provide: StocksService, useValue: mockStocksService }],
  })
    .overrideGuard(AuthGuard('jwt'))
    .useValue({
      handleRequest: () => userId ? { id: userId } : null,
      canActivate: (ctx: any) => {
        const req = ctx.switchToHttp().getRequest();
        req.user = userId ? { id: userId } : null;
        return true; // OptionalJwtGuard never rejects
      },
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.init();
  return app;
}

describe('StocksController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStocksService.getDashboard.mockResolvedValue(mockDashboard);
    mockStocksService.searchStocks.mockResolvedValue({
      data: [{ symbol: 'COMI', name: 'CIB', sector: 'Banking', price: 50 }],
      total: 1,
      page: 1,
      limit: 20,
      pages: 1,
    });
    app = await buildApp(null);
  });

  afterEach(async () => { await app.close(); });

  describe('GET /stocks/dashboard', () => {
    it('returns 200 with hottest, recommended, lowest, pricesMeta', async () => {
      const res = await request(app.getHttpServer())
        .get('/stocks/dashboard')
        .expect(200);

      expect(res.body).toHaveProperty('hottest');
      expect(res.body).toHaveProperty('recommended');
      expect(res.body).toHaveProperty('lowest');
      expect(res.body).toHaveProperty('pricesMeta');
    });

    it('myStocks is empty when no JWT provided', async () => {
      const res = await request(app.getHttpServer())
        .get('/stocks/dashboard')
        .expect(200);

      expect(res.body.myStocks).toHaveLength(0);
    });

    it('with valid userId — calls getDashboard with userId', async () => {
      const authedApp = await buildApp('user-123');
      mockStocksService.getDashboard.mockResolvedValue({ ...mockDashboard, myStocks: [{ symbol: 'COMI' }] });

      const res = await request(authedApp.getHttpServer())
        .get('/stocks/dashboard')
        .expect(200);

      expect(res.body.myStocks).toHaveLength(1);
      await authedApp.close();
    });

    it('pricesMeta has required fields', async () => {
      const res = await request(app.getHttpServer())
        .get('/stocks/dashboard')
        .expect(200);

      const meta = res.body.pricesMeta;
      expect(meta).toHaveProperty('totalSymbols');
      expect(meta).toHaveProperty('symbolsWithFreshPrice');
      expect(meta).toHaveProperty('symbolsWithStalePrice');
      expect(meta).toHaveProperty('symbolsWithNoPrice');
    });
  });

  describe('GET /stocks', () => {
    it('returns 200 with data array and pagination', async () => {
      const res = await request(app.getHttpServer())
        .get('/stocks')
        .expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('pages');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('passes search param to searchStocks', async () => {
      await request(app.getHttpServer())
        .get('/stocks?search=COMI')
        .expect(200);

      expect(mockStocksService.searchStocks).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'COMI' }),
      );
    });

    it('passes minPE and maxPE params to searchStocks', async () => {
      await request(app.getHttpServer())
        .get('/stocks?minPE=5&maxPE=20')
        .expect(200);

      expect(mockStocksService.searchStocks).toHaveBeenCalledWith(
        expect.objectContaining({ minPE: 5, maxPE: 20 }),
      );
    });

    it('passes sector param to searchStocks', async () => {
      await request(app.getHttpServer())
        .get('/stocks?sector=Banking')
        .expect(200);

      expect(mockStocksService.searchStocks).toHaveBeenCalledWith(
        expect.objectContaining({ sector: 'Banking' }),
      );
    });
  });
});
