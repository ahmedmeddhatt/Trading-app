import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Subject } from 'rxjs';

export interface PriceUpdate {
  symbol: string;
  price: number;
  timestamp: number;
}

@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);
  private subscriber: Redis;

  readonly priceUpdates$ = new Subject<PriceUpdate>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.subscriber = new Redis(
      this.config.get<string>('REDIS_URL', 'redis://localhost:6379'),
    );

    this.subscriber.subscribe('prices', (err) => {
      if (err) {
        this.logger.error(`Failed to subscribe to prices channel: ${err.message}`);
        return;
      }
      this.logger.log('Subscribed to Redis prices channel');
    });

    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        const update: PriceUpdate = JSON.parse(message);
        this.priceUpdates$.next(update);
      } catch {
        this.logger.warn(`Invalid price message: ${message}`);
      }
    });
  }

  onModuleDestroy(): void {
    this.subscriber.disconnect();
  }
}
