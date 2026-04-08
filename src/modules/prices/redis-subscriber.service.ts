import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Subject } from 'rxjs';
import {
  PRICES_UPDATED,
  GOLD_PRICES_UPDATED,
} from '../../common/constants/event-names';

export interface PriceUpdate {
  symbol: string;
  price: number;
  changePercent: number;
  lastUpdate: string;
  recommendation?: string | null;
  signals?: {
    daily: string | null;
    weekly: string | null;
    monthly: string | null;
  } | null;
}

export interface GoldPriceUpdate {
  categoryId: string;
  buyPrice: number;
  sellPrice: number;
  changePercent: number;
  timestamp: string;
  source: string;
  globalSpotUsd: number | null;
}

/**
 * Bridges the in-process PRICES_UPDATED / GOLD_PRICES_UPDATED events to RxJS Subjects
 * so that PricesService can stream updates to SSE clients.
 */
@Injectable()
export class RedisSubscriberService {
  readonly priceUpdates$ = new Subject<PriceUpdate>();
  readonly goldPriceUpdates$ = new Subject<GoldPriceUpdate>();

  @OnEvent(PRICES_UPDATED)
  onPricesUpdated(payload: { updates: PriceUpdate[] }): void {
    for (const update of payload.updates ?? []) {
      this.priceUpdates$.next(update);
    }
  }

  @OnEvent(GOLD_PRICES_UPDATED)
  onGoldPricesUpdated(payload: { updates: GoldPriceUpdate[] }): void {
    for (const update of payload.updates ?? []) {
      this.goldPriceUpdates$.next(update);
    }
  }
}
