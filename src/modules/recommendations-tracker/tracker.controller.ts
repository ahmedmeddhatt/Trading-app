import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminEmailGuard } from './admin-email.guard';
import { TrackerService } from './tracker.service';

@Controller('recommendations-tracker')
@UseGuards(JwtAuthGuard, AdminEmailGuard)
export class TrackerController {
  constructor(private readonly tracker: TrackerService) {}

  @Get('snapshots')
  async listSnapshots(
    @Query('aiProvider') aiProvider?: string,
    @Query('kind') kind?: string,
  ) {
    const validKind = kind === 'daily' || kind === 'weekly' ? kind : undefined;
    return this.tracker.getSnapshots(aiProvider, validKind);
  }

  @Get('snapshots/by-date')
  async snapshotByDate(
    @Query('date') date: string,
    @Query('lang') lang?: string,
  ) {
    return this.tracker.getSnapshotByDate(date, lang);
  }

  @Get('picks/:pickId')
  async pickDetail(
    @Param('pickId') pickId: string,
    @Query('lang') lang?: string,
  ) {
    return this.tracker.getPickDetail(pickId, lang);
  }

  @Get('stats')
  async stats() {
    return this.tracker.getStats();
  }

  @Post('snapshot')
  async manualSnapshot(@Body() body: { weekStartDate?: string }) {
    const date = body?.weekStartDate ? new Date(body.weekStartDate) : undefined;
    return this.tracker.captureSnapshot(date);
  }

  @Post('evaluate')
  async manualEvaluate() {
    return this.tracker.evaluateAllActive();
  }

  @Post('backfill-ar')
  async backfillAr() {
    return this.tracker.backfillArPayloads();
  }
}
