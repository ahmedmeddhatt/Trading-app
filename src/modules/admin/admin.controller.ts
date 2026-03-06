import { Controller, Post, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(
    @InjectQueue('debug-scraper') private readonly debugQueue: Queue,
  ) {}

  @Post('scraper/debug')
  async triggerDebug() {
    const job = await this.debugQueue.add('debug-egxpilot', {}, {
      removeOnComplete: 5,
      removeOnFail: 5,
    });
    return { jobId: job.id, message: 'Debug job enqueued — check logs for result' };
  }
}
