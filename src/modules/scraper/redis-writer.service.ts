import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisWriterService.name);
  private client: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.client = new Redis(
      this.config.get<string>('REDIS_URL', 'redis://localhost:6379'),
      {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 500, 10000),
      },
    );

    this.client.on('error', (err) => {
      this.logger.warn(`Redis writer error: ${err.message}`);
    });

    this.client.connect().catch((err) => {
      this.logger.warn(`Redis writer initial connect failed: ${err.message}`);
    });
  }

  async hset(symbol: string, value: string): Promise<void> {
    await this.client.hset('market:prices', symbol, value);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
