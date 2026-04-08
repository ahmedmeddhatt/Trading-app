import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';

const TROY_OUNCE_GRAMS = 31.1035;

/** Purity ratios for each karat */
const KARAT_PURITY: Record<string, number> = {
  GOLD_24K: 0.9999,
  GOLD_21K: 0.875,
  GOLD_18K: 0.75,
  GOLD_14K: 0.5833,
  GOLD_BAR: 0.9999,
  GOLD_POUND: 0.875,
  GOLD_OUNCE: 0.9999,
};

/** Fixed weight items */
const FIXED_WEIGHT: Record<string, number> = {
  GOLD_POUND: 8.0,
  GOLD_OUNCE: TROY_OUNCE_GRAMS,
};

/** Premium percentages for special items */
const PREMIUM: Record<string, number> = {
  GOLD_BAR: 0.01,
  GOLD_POUND: 0.035,
};

/** Default buy/sell spread (dealer markup) */
const DEFAULT_SPREAD_PERCENT = 0.02;

export interface GoldPriceData {
  categoryId: string;
  buyPrice: number;
  sellPrice: number;
  changePercent: number;
  timestamp: string;
  source: string;
  globalSpotUsd: number | null;
}

interface SpotData {
  xauUsd: number;
  usdEgp: number;
  source: string;
}

@Injectable()
export class GoldScraperService {
  private readonly logger = new Logger(GoldScraperService.name);
  private previousPrices: Map<string, number> = new Map();

  /**
   * Fetch gold prices from multiple sources with fallback chain.
   * Returns prices for all 7 gold categories.
   */
  async fetchPrices(): Promise<GoldPriceData[]> {
    const spot = await this.getSpotData();
    if (!spot) {
      this.logger.error(
        'All gold price sources failed — no spot data available',
      );
      return [];
    }

    const pricePerGram24K = (spot.xauUsd * spot.usdEgp) / TROY_OUNCE_GRAMS;
    const timestamp = new Date().toISOString();
    const categories = Object.keys(KARAT_PURITY);

    // Try to get Egyptian dealer spread from iSagha
    const dealerSpread = await this.fetchIsaghaSpread().catch(() => null);

    const results: GoldPriceData[] = [];

    for (const categoryId of categories) {
      const purity = KARAT_PURITY[categoryId];
      let basePrice = pricePerGram24K * purity;

      // Apply premium for special items
      if (PREMIUM[categoryId]) {
        basePrice *= 1 + PREMIUM[categoryId];
      }

      // For fixed-weight items, multiply by weight
      const weight = FIXED_WEIGHT[categoryId];
      if (weight) {
        basePrice *= weight;
      }

      // Determine buy/sell spread (cap at 10% to guard against bad scrape data)
      const rawSpread = dealerSpread?.[categoryId] ?? DEFAULT_SPREAD_PERCENT;
      const spreadPct = Math.min(rawSpread, 0.1);
      const sellPrice = Math.round(basePrice * 100) / 100;
      const buyPrice = Math.round(basePrice * (1 + spreadPct) * 100) / 100;

      // Calculate change from previous scrape
      const prevSell = this.previousPrices.get(categoryId);
      const changePercent = prevSell
        ? +(((sellPrice - prevSell) / prevSell) * 100).toFixed(2)
        : 0;
      this.previousPrices.set(categoryId, sellPrice);

      results.push({
        categoryId,
        buyPrice,
        sellPrice,
        changePercent,
        timestamp,
        source: spot.source,
        globalSpotUsd: spot.xauUsd,
      });
    }

    this.logger.log(
      `gold-scraper: calculated ${results.length} category prices (24K/gram: ${pricePerGram24K.toFixed(2)} EGP, source: ${spot.source})`,
    );
    return results;
  }

  /**
   * Get XAU/USD spot price and USD/EGP rate from multiple sources.
   */
  private async getSpotData(): Promise<SpotData | null> {
    // Strategy 1: gold-api.com (XAU/USD) + open.er-api.com (USD/EGP)
    try {
      const [xauRes, fxRes] = await Promise.all([
        this.fetchJson<{ price: number }>('https://api.gold-api.com/price/XAU'),
        this.fetchJson<{ rates: { EGP: number } }>(
          'https://open.er-api.com/v6/latest/USD',
        ),
      ]);
      if (xauRes?.price && fxRes?.rates?.EGP) {
        return {
          xauUsd: xauRes.price,
          usdEgp: fxRes.rates.EGP,
          source: 'gold-api+er-api',
        };
      }
    } catch (err) {
      this.logger.warn(
        `Source 1 (gold-api+er-api) failed: ${(err as Error).message}`,
      );
    }

    // Strategy 2: XE.com (XAU→EGP direct) + er-api for USD/EGP
    try {
      const [xauEgp, fxRes] = await Promise.all([
        this.fetchXeGoldPrice(),
        this.fetchJson<{ rates: { EGP: number } }>(
          'https://open.er-api.com/v6/latest/USD',
        ),
      ]);
      if (xauEgp && fxRes?.rates?.EGP) {
        return {
          xauUsd: xauEgp / fxRes.rates.EGP,
          usdEgp: fxRes.rates.EGP,
          source: 'xe+er-api',
        };
      }
      if (xauEgp) {
        // XE worked but no FX rate — estimate USD/EGP
        return { xauUsd: xauEgp / 50, usdEgp: 50, source: 'xe-only' };
      }
    } catch (err) {
      this.logger.warn(
        `Source 2 (XE+er-api) failed: ${(err as Error).message}`,
      );
    }

    // Strategy 3: FX rate only — use last known XAU/USD or reasonable estimate
    try {
      const fxRes = await this.fetchJson<{ rates: { EGP: number } }>(
        'https://open.er-api.com/v6/latest/USD',
      );
      if (fxRes?.rates?.EGP) {
        this.logger.warn(
          'Using fallback XAU/USD estimate — gold prices may be approximate',
        );
        return {
          xauUsd: 3200,
          usdEgp: fxRes.rates.EGP,
          source: 'er-api-fallback',
        };
      }
    } catch (err) {
      this.logger.warn(
        `Source 3 (er-api fallback) failed: ${(err as Error).message}`,
      );
    }

    return null;
  }

  /** Fetch XAU→EGP rate from XE.com */
  private async fetchXeGoldPrice(): Promise<number | null> {
    const url =
      'https://www.xe.com/currencyconverter/convert/?Amount=1&From=XAU&To=EGP';
    const html = await this.fetchHtml(url);
    if (!html) return null;

    const $ = cheerio.load(html);
    // XE typically shows rate in a prominent element — look for the conversion result
    const text = $('body').text();
    const match = text.match(/1\s*XAU\s*=\s*([\d,]+\.?\d*)\s*EGP/i);
    if (match) {
      return parseFloat(match[1].replace(/,/g, ''));
    }
    return null;
  }

  /**
   * Try to get Egyptian dealer buy/sell spread from iSagha.
   * Note: iSagha is JS-rendered, so this only works if prices appear in initial HTML.
   * Returns null if site is fully JS-rendered (expected behavior).
   */
  private async fetchIsaghaSpread(): Promise<Record<string, number> | null> {
    const html = await this.fetchHtml('https://market.isagha.com/');
    if (!html) return null;

    const $ = cheerio.load(html);
    const text = $('body').text();
    const spreads: Record<string, number> = {};

    const karatMap: Record<string, string> = {
      '24': 'GOLD_24K',
      '21': 'GOLD_21K',
      '18': 'GOLD_18K',
      '14': 'GOLD_14K',
    };

    for (const [karat, catId] of Object.entries(karatMap)) {
      // Look for "عيار 21" followed by price-like numbers (at least 3 digits)
      const pattern = new RegExp(
        `عيار\\s*${karat}[^\\d]*(\\d{3,}[\\d,]*\\.?\\d*)\\s*[^\\d]*(\\d{3,}[\\d,]*\\.?\\d*)`,
        'i',
      );
      const m = text.match(pattern);
      if (m) {
        const price1 = parseFloat(m[1].replace(/,/g, ''));
        const price2 = parseFloat(m[2].replace(/,/g, ''));
        if (price1 > 100 && price2 > 100) {
          const buy = Math.max(price1, price2);
          const sell = Math.min(price1, price2);
          const spread = (buy - sell) / sell;
          if (spread < 0.1) {
            // Only use if spread is reasonable (< 10%)
            spreads[catId] = spread;
          }
        }
      }
    }

    if (Object.keys(spreads).length === 0) {
      this.logger.debug(
        'iSagha: no prices in HTML (JS-rendered) — using default spread',
      );
      return null;
    }
    return spreads;
  }

  /** Generic JSON fetch helper */
  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`fetchJson(${url}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Generic HTML fetch helper */
  private async fetchHtml(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      this.logger.warn(`fetchHtml(${url}) failed: ${(err as Error).message}`);
      return null;
    }
  }
}
