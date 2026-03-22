import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Subject } from 'rxjs';
import { PRICES_UPDATED } from '../../common/constants/event-names';

export interface PriceUpdate {
  symbol: string;
  price: number;
  changePercent: number;
  lastUpdate: string;
  recommendation?: string | null;
  signals?: { daily: string | null; weekly: string | null; monthly: string | null } | null;
}

/**
 * Bridges the in-process PRICES_UPDATED event to an RxJS Subject so that
 * PricesService can stream updates to SSE clients.
 * No Redis connection needed — fully in-process.
 */
@Injectable()
export class RedisSubscriberService {
  readonly priceUpdates$ = new Subject<PriceUpdate>();

  @OnEvent(PRICES_UPDATED)
  onPricesUpdated(payload: { updates: PriceUpdate[] }): void {
    for (const update of payload.updates ?? []) {
      this.priceUpdates$.next(update);
    }
  }
}
