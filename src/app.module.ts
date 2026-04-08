import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from './database/prisma.module';
import { UsersModule } from './modules/users/users.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { PositionsModule } from './modules/positions/positions.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { AuthModule } from './modules/auth/auth.module';
import { PricesModule } from './modules/prices/prices.module';
import { ScraperModule } from './modules/scraper/scraper.module';
import { HealthModule } from './modules/health/health.module';
import { StocksModule } from './modules/stocks/stocks.module';
import { RedisModule } from './common/redis/redis.module';
import { AdminModule } from './modules/admin/admin.module';
import { GoldModule } from './modules/gold/gold.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: (res) => ({ statusCode: res.statusCode }),
        },
        customLogLevel: (_req, res) =>
          res.statusCode >= 500
            ? 'error'
            : res.statusCode >= 400
              ? 'warn'
              : 'info',
      },
    }),
    EventEmitterModule.forRoot(),
    RedisModule,
    PrismaModule,
    UsersModule,
    TransactionsModule,
    PositionsModule,
    PortfolioModule,
    AuthModule,
    PricesModule,
    ScraperModule,
    HealthModule,
    StocksModule,
    AdminModule,
    GoldModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
