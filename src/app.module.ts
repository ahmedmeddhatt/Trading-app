import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';
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
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' },
    }),
    EventEmitterModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL', 'redis://localhost:6379');
        return { connection: { url, ...(url.startsWith('rediss://') && { tls: {} }) } };
      },
    }),
    PrismaModule,
    UsersModule,
    TransactionsModule,
    PositionsModule,
    PortfolioModule,
    AuthModule,
    PricesModule,
    ScraperModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
