import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  SMA, EMA, MACD, RSI, BollingerBands, ROC,
} from 'technicalindicators';

type Trend = 'uptrend' | 'downtrend' | 'sideways';
type Signal = 'Strong Buy' | 'Buy' | 'Neutral' | 'Sell' | 'Strong Sell';
type Confidence = 'High' | 'Medium' | 'Low';
type MACDTrend = 'bullish' | 'bearish' | 'neutral';
type RSIZone = 'overbought' | 'oversold' | 'neutral';

@Injectable()
export class TechnicalAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async analyze(symbol: string) {
    const upperSymbol = symbol.toUpperCase();

    // Fetch last 500 price records (ordered asc for indicator calc)
    const history = await this.prisma.stockPriceHistory.findMany({
      where: { symbol: upperSymbol },
      orderBy: { timestamp: 'asc' },
      select: { price: true, timestamp: true },
      take: 500,
    });

    if (history.length < 20) {
      return { symbol: upperSymbol, error: 'Insufficient price history for technical analysis', minRequired: 20, available: history.length };
    }

    const prices = history.map((h) => parseFloat(h.price.toString()));
    const timestamps = history.map((h) => h.timestamp.toISOString());

    // Live price
    const rawPrices = await this.redis.hgetall('market:prices');
    let currentPrice: number | null = null;
    try {
      const parsed = rawPrices?.[upperSymbol] ? JSON.parse(rawPrices[upperSymbol]) : null;
      currentPrice = parsed?.price ?? null;
    } catch { /* noop */ }
    if (currentPrice == null) currentPrice = prices[prices.length - 1];

    // ── Compute indicators ────────────────────────────────────────────────
    const n = prices.length;

    const sma20arr = SMA.calculate({ period: 20, values: prices });
    const sma50arr = prices.length >= 50 ? SMA.calculate({ period: 50, values: prices }) : [];
    const sma200arr = prices.length >= 200 ? SMA.calculate({ period: 200, values: prices }) : [];
    const ema12arr = EMA.calculate({ period: 12, values: prices });
    const ema26arr = EMA.calculate({ period: 26, values: prices });
    const macdArr = prices.length >= 35 ? MACD.calculate({
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      values: prices, SimpleMAOscillator: false, SimpleMASignal: false,
    }) : [];
    const rsiArr = prices.length >= 14 ? RSI.calculate({ period: 14, values: prices }) : [];
    const bbArr = prices.length >= 20 ? BollingerBands.calculate({ period: 20, stdDev: 2, values: prices }) : [];
    const rocArr = prices.length >= 10 ? ROC.calculate({ period: 10, values: prices }) : [];

    // Latest values
    const sma20 = sma20arr.length ? sma20arr[sma20arr.length - 1] : null;
    const sma50 = sma50arr.length ? sma50arr[sma50arr.length - 1] : null;
    const sma200 = sma200arr.length ? sma200arr[sma200arr.length - 1] : null;
    const ema12 = ema12arr.length ? ema12arr[ema12arr.length - 1] : null;
    const ema26 = ema26arr.length ? ema26arr[ema26arr.length - 1] : null;
    const macd = macdArr.length ? macdArr[macdArr.length - 1] : null;
    const rsi = rsiArr.length ? rsiArr[rsiArr.length - 1] : null;
    const bb = bbArr.length ? bbArr[bbArr.length - 1] : null;
    const roc10 = rocArr.length ? rocArr[rocArr.length - 1] : null;
    const momentum20 = n >= 21 ? currentPrice - prices[n - 21] : null;

    // MACD trend
    const macdTrend: MACDTrend = macd?.MACD != null && macd?.signal != null
      ? (macd.MACD > macd.signal ? 'bullish' : macd.MACD < macd.signal ? 'bearish' : 'neutral')
      : 'neutral';

    // RSI zone
    const rsiZone: RSIZone = rsi == null ? 'neutral' : rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : 'neutral';

    // Bollinger %B
    const bbPercentB = bb != null ? ((currentPrice - bb.lower) / (bb.upper - bb.lower)) * 100 : null;
    const bbBandwidth = bb != null ? ((bb.upper - bb.lower) / bb.middle) * 100 : null;

    // ── Trend analysis ────────────────────────────────────────────────────
    const getTrend = (smaArr: number[], lookback = 5): Trend => {
      if (smaArr.length < lookback + 1) return 'sideways';
      const recent = smaArr[smaArr.length - 1];
      const prev = smaArr[smaArr.length - 1 - lookback];
      const diff = (recent - prev) / prev * 100;
      if (diff > 0.5) return 'uptrend';
      if (diff < -0.5) return 'downtrend';
      return 'sideways';
    };

    const shortTrend = getTrend(sma20arr, 3);
    const mediumTrend = getTrend(sma50arr, 5);
    const longTrend = getTrend(sma200arr, 10);

    // Golden/Death cross (SMA50 crosses SMA200 within last 20 periods)
    let goldenCross = false, deathCross = false;
    if (sma50arr.length >= 20 && sma200arr.length >= 20) {
      const offset50 = sma50arr.length - Math.min(20, sma50arr.length);
      const offset200 = sma200arr.length - Math.min(20, sma200arr.length);
      for (let i = 1; i < Math.min(20, sma50arr.length, sma200arr.length); i++) {
        const cur50 = sma50arr[sma50arr.length - 1 - i];
        const prev50 = sma50arr[sma50arr.length - 2 - i];
        const cur200 = sma200arr[sma200arr.length - 1 - i + offset200 - offset50];
        const prev200 = sma200arr[sma200arr.length - 2 - i + offset200 - offset50];
        if (cur200 != null && prev50 != null && prev200 != null) {
          if (prev50 < prev200 && cur50 > cur200) { goldenCross = true; break; }
          if (prev50 > prev200 && cur50 < cur200) { deathCross = true; break; }
        }
      }
    }

    // ── Support & Resistance ──────────────────────────────────────────────
    const window = 5;
    const supports: number[] = [], resistances: number[] = [];
    const last200 = prices.slice(-200);
    for (let i = window; i < last200.length - window; i++) {
      const slice = last200.slice(i - window, i + window + 1);
      const p = last200[i];
      if (p === Math.min(...slice)) supports.push(p);
      if (p === Math.max(...slice)) resistances.push(p);
    }

    // cluster nearby levels (within 0.5%)
    const cluster = (levels: number[]): number[] => {
      const sorted = [...new Set(levels)].sort((a, b) => a - b);
      const clustered: number[] = [];
      let group: number[] = [];
      for (const l of sorted) {
        if (!group.length || (l - group[0]) / group[0] < 0.005) {
          group.push(l);
        } else {
          clustered.push(group.reduce((s, v) => s + v, 0) / group.length);
          group = [l];
        }
      }
      if (group.length) clustered.push(group.reduce((s, v) => s + v, 0) / group.length);
      return clustered;
    };

    const allSupports = cluster(supports).filter((s) => s < currentPrice!).sort((a, b) => b - a).slice(0, 3);
    const allResistances = cluster(resistances).filter((r) => r > currentPrice!).sort((a, b) => a - b).slice(0, 3);

    // ── Overall Signal Scoring ────────────────────────────────────────────
    let score = 0;
    const basis: string[] = [];

    if (rsi != null) {
      if (rsi < 30) { score += 20; basis.push('RSI oversold (buy signal)'); }
      else if (rsi > 70) { score -= 20; basis.push('RSI overbought (sell signal)'); }
      else { basis.push(`RSI neutral at ${rsi.toFixed(1)}`); }
    }
    if (sma20 != null) {
      if (currentPrice > sma20) { score += 10; basis.push('Price above SMA20'); }
      else { score -= 10; basis.push('Price below SMA20'); }
    }
    if (sma50 != null) {
      if (currentPrice > sma50) { score += 15; basis.push('Price above SMA50'); }
      else { score -= 15; basis.push('Price below SMA50'); }
    }
    if (sma200 != null) {
      if (currentPrice > sma200) { score += 20; basis.push('Price above SMA200 (long-term bullish)'); }
      else { score -= 20; basis.push('Price below SMA200 (long-term bearish)'); }
    }
    if (macd?.MACD != null && macd?.signal != null) {
      if (macd.MACD > macd.signal) { score += 15; basis.push('MACD above signal (bullish cross)'); }
      else { score -= 15; basis.push('MACD below signal (bearish)'); }
    }
    if (goldenCross) { score += 20; basis.push('Golden Cross recently detected'); }
    if (deathCross) { score -= 20; basis.push('Death Cross recently detected'); }

    const action: Signal =
      score >= 50 ? 'Strong Buy' :
      score >= 20 ? 'Buy' :
      score <= -50 ? 'Strong Sell' :
      score <= -20 ? 'Sell' : 'Neutral';

    const confidence: Confidence =
      (rsi != null && sma200 != null && macd != null) ? 'High' :
      (rsi != null && sma50 != null) ? 'Medium' : 'Low';

    // ── Build historical chart data (last 200 points with indicator values) ──
    const startIdx = Math.max(0, n - 200);
    const chartData = history.slice(startIdx).map((h, i) => {
      const absIdx = startIdx + i;
      // align indicator arrays (they start after their lookback period)
      const sma20val = absIdx >= 19 ? sma20arr[absIdx - 19] ?? null : null;
      const sma50val = absIdx >= 49 ? sma50arr[absIdx - 49] ?? null : null;
      const ema12val = absIdx >= 11 ? ema12arr[absIdx - 11] ?? null : null;
      const ema26val = absIdx >= 25 ? ema26arr[absIdx - 25] ?? null : null;
      const bbVal = absIdx >= 19 ? bbArr[absIdx - 19] ?? null : null;
      const macdOffset = 33; // 26 + 9 - 1 - 1
      const macdVal = absIdx >= macdOffset ? macdArr[absIdx - macdOffset] ?? null : null;
      const rsiVal = absIdx >= 13 ? rsiArr[absIdx - 13] ?? null : null;

      return {
        timestamp: h.timestamp.toISOString(),
        price: parseFloat(h.price.toString()),
        sma20: sma20val != null ? parseFloat(sma20val.toFixed(2)) : null,
        sma50: sma50val != null ? parseFloat(sma50val.toFixed(2)) : null,
        ema12: ema12val != null ? parseFloat(ema12val.toFixed(2)) : null,
        ema26: ema26val != null ? parseFloat(ema26val.toFixed(2)) : null,
        bollingerUpper: bbVal != null ? parseFloat(bbVal.upper.toFixed(2)) : null,
        bollingerMiddle: bbVal != null ? parseFloat(bbVal.middle.toFixed(2)) : null,
        bollingerLower: bbVal != null ? parseFloat(bbVal.lower.toFixed(2)) : null,
        macdValue: macdVal?.MACD != null ? parseFloat(macdVal.MACD.toFixed(4)) : null,
        macdSignal: macdVal?.signal != null ? parseFloat(macdVal.signal.toFixed(4)) : null,
        macdHistogram: macdVal?.histogram != null ? parseFloat(macdVal.histogram.toFixed(4)) : null,
        rsi: rsiVal != null ? parseFloat(rsiVal.toFixed(2)) : null,
      };
    });

    return {
      symbol: upperSymbol,
      currentPrice,
      dataPoints: n,
      indicators: {
        sma20: sma20 != null ? parseFloat(sma20.toFixed(2)) : null,
        sma50: sma50 != null ? parseFloat(sma50.toFixed(2)) : null,
        sma200: sma200 != null ? parseFloat(sma200.toFixed(2)) : null,
        ema12: ema12 != null ? parseFloat(ema12.toFixed(2)) : null,
        ema26: ema26 != null ? parseFloat(ema26.toFixed(2)) : null,
        macd: {
          value: macd?.MACD != null ? parseFloat(macd.MACD.toFixed(4)) : null,
          signal: macd?.signal != null ? parseFloat(macd.signal.toFixed(4)) : null,
          histogram: macd?.histogram != null ? parseFloat(macd.histogram.toFixed(4)) : null,
          trend: macdTrend,
        },
        rsi14: {
          value: rsi != null ? parseFloat(rsi.toFixed(2)) : null,
          zone: rsiZone,
        },
        bollingerBands: {
          upper: bb != null ? parseFloat(bb.upper.toFixed(2)) : null,
          middle: bb != null ? parseFloat(bb.middle.toFixed(2)) : null,
          lower: bb != null ? parseFloat(bb.lower.toFixed(2)) : null,
          bandwidth: bbBandwidth != null ? parseFloat(bbBandwidth.toFixed(2)) : null,
          percentB: bbPercentB != null ? parseFloat(bbPercentB.toFixed(2)) : null,
        },
        roc10: roc10 != null ? parseFloat(roc10.toFixed(4)) : null,
        momentum20: momentum20 != null ? parseFloat(momentum20.toFixed(2)) : null,
      },
      trendAnalysis: {
        shortTerm: shortTrend,
        mediumTerm: mediumTrend,
        longTerm: longTrend,
        priceVsSma20: sma20 != null ? parseFloat(((currentPrice - sma20) / sma20 * 100).toFixed(2)) : null,
        priceVsSma50: sma50 != null ? parseFloat(((currentPrice - sma50) / sma50 * 100).toFixed(2)) : null,
        priceVsSma200: sma200 != null ? parseFloat(((currentPrice - sma200) / sma200 * 100).toFixed(2)) : null,
        goldenCross,
        deathCross,
      },
      supportResistance: {
        supports: allSupports.map((s) => parseFloat(s.toFixed(2))),
        resistances: allResistances.map((r) => parseFloat(r.toFixed(2))),
      },
      overallSignal: {
        score,
        action,
        basis,
        confidence,
      },
      priceHistory: chartData,
    };
  }
}
