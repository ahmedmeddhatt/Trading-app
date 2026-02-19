import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { RedisSubscriberService } from './redis-subscriber.service';
import { MessageEvent } from '@nestjs/common';

@Injectable()
export class PricesService {
  constructor(private readonly redis: RedisSubscriberService) {}

  getStream(symbol?: string): Observable<MessageEvent> {
    return this.redis.priceUpdates$.pipe(
      filter((update) =>
        symbol ? update.symbol.toUpperCase() === symbol.toUpperCase() : true,
      ),
      map((update) => ({ data: update }) as MessageEvent),
    );
  }
}
