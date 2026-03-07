import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisMonitorService } from './redis-monitor.service';

@Injectable()
export class RedisWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisWriterService.name);
  private client: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly monitor: RedisMonitorService,
  ) {}

  onModuleInit(): void {
    const url = this.config.get<string>('UPSTASH_REDIS_URL', 'redis://localhost:6379');
    this.client = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 500, 10000),
      ...(url.startsWith('rediss://') && { tls: {} }),
    });

    this.client.on('error', (err) => {
      this.logger.warn(`Redis writer error: ${err.message}`);
    });

    this.client.connect()
      .then(async () => {
        // Fingerprint check — confirms round-trip to correct DB
        await this.client.set(
          'app:connection:verified',
          JSON.stringify({ service: 'trading-app', connectedAt: new Date().toISOString() }),
          'EX',
          86400,
        );
        const val = await this.client.get('app:connection:verified');
        if (!val) throw new Error('REDIS_VERIFY_FAILED: Could not read back verification key');
        const host = url.split('@')[1]?.split(':')[0] ?? 'unknown';
        this.logger.log(`RedisWriter verified — connected to host: ${host}`);
        this.logger.log('RedisWriter connection check: PASS');
      })
      .catch((err) => {
        this.logger.warn(`Redis writer initial connect failed: ${err.message}`);
      });
  }

  async hset(symbol: string, value: string): Promise<void> {
    this.monitor.increment('HSET');
    await this.client.hset('market:prices', symbol, value);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.monitor.increment('HGETALL');
    return this.client.hgetall(key);
  }

  async publish(channel: string, message: string): Promise<void> {
    this.monitor.increment('PUBLISH');
    await this.client.publish(channel, message);
  }

  async set(key: string, value: string): Promise<void> {
    this.monitor.increment('SET');
    await this.client.set(key, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.monitor.increment('HGET');
    return this.client.hget(key, field);
  }

  async get(key: string): Promise<string | null> {
    this.monitor.increment('GET');
    return this.client.get(key);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
