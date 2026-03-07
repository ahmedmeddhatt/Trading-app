import { Controller, Get } from '@nestjs/common';
import { getMarketStatus } from './utils/market-hours';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    const marketStatus = getMarketStatus();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      marketStatus,
    };
  }
}
