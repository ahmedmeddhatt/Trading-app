import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './database/prisma.module';
import { UsersModule } from './modules/users/users.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { PositionsModule } from './modules/positions/positions.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { AuthModule } from './modules/auth/auth.module';
import { PricesModule } from './modules/prices/prices.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    PrismaModule,
    UsersModule,
    TransactionsModule,
    PositionsModule,
    PortfolioModule,
    AuthModule,
    PricesModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
