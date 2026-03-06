import { Module } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { PortfolioController } from './portfolio.controller';
import { PositionsModule } from '../positions/positions.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PositionsModule, AuthModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
})
export class PortfolioModule {}
