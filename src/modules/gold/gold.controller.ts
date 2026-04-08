import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { GoldService } from './gold.service';
import { GoldAnalysisService } from '../scraper/services/gold-analysis.service';
import { AuthGuard } from '@nestjs/passport';

class OptionalJwtGuard extends AuthGuard('jwt') {
  handleRequest(_err: any, user: any): any {
    return user ?? null;
  }
}

@Controller('gold')
export class GoldController {
  constructor(
    private readonly goldService: GoldService,
    private readonly goldAnalysis: GoldAnalysisService,
  ) {}

  @Get('dashboard')
  @UseGuards(OptionalJwtGuard)
  getDashboard(@Request() req: { user?: { id: string } }) {
    return this.goldService.getDashboard(req.user?.id);
  }

  @Get('categories')
  getCategories() {
    return this.goldService.getCategories();
  }

  @Get(':categoryId/history')
  getHistory(
    @Param('categoryId') categoryId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.goldService.getHistory(
      categoryId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Get(':categoryId/signal')
  getSignal(
    @Param('categoryId') categoryId: string,
    @Query('horizon')
    horizon: 'SPECULATION' | 'MID_TERM' | 'LONG_TERM' = 'MID_TERM',
  ) {
    return this.goldAnalysis.analyzeGold(categoryId, horizon);
  }

  @Post('analysis')
  analyzeMultiple(
    @Body()
    body: {
      categoryIds: string[];
      horizon?: 'SPECULATION' | 'MID_TERM' | 'LONG_TERM';
    },
  ) {
    const ids = (body.categoryIds ?? []).slice(0, 7);
    return this.goldAnalysis.analyzeMultiple(ids, body.horizon ?? 'MID_TERM');
  }

  @Get(':categoryId')
  getByCategory(@Param('categoryId') categoryId: string) {
    return this.goldService.getByCategory(categoryId);
  }
}
