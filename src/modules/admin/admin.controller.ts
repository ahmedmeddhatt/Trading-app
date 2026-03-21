import { Controller, Post, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const JOB_OPTS = { attempts: 3, backoff: { type: 'exponential' as const, delay: 5_000 }, removeOnComplete: 5, removeOnFail: 5 };

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(
    @InjectQueue('debug-scraper') private readonly debugQueue: Queue,
    @InjectQueue('list-scraper') private readonly listQueue: Queue,
    @InjectQueue('price-scraper') private readonly priceQueue: Queue,
  ) {}

  @Post('scraper/debug')
  async triggerDebug() {
    const job = await this.debugQueue.add('debug-egxpilot', {}, JOB_OPTS);
    return { jobId: job.id, message: 'Debug job enqueued — check logs for result' };
  }

  @Post('scraper/list')
  @UseGuards()
  async triggerList() {
    const job = await this.listQueue.add('fetch-list-manual', {}, JOB_OPTS);
    return { jobId: job.id, message: 'List-scraper job enqueued' };
  }

  @Post('scraper/prices')
  @UseGuards()
  async triggerPrices() {
    const job = await this.priceQueue.add('fetch-prices-manual', { force: true }, JOB_OPTS);
    return { jobId: job.id, message: 'Price-scraper job enqueued (market hours bypassed)' };
  }
}
