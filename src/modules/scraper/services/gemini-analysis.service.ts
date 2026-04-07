import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { TechnicalAnalysisService } from '../technical-analysis.service';
import { NewsScraperService } from './news-scraper.service';

export interface AISignalResult {
  signal: 'Strong Buy' | 'Buy' | 'Neutral' | 'Sell' | 'Strong Sell';
  confidence: 'High' | 'Medium' | 'Low';
  score: number;
  reasons: string[];
  summary: string;
  risks: string[];
  targetAction: string;
  horizon: string;
  source: 'ai' | 'technical-fallback';
  externalSignals?: {
    daily: string | null;
    weekly: string | null;
    monthly: string | null;
  };
}

type Horizon = 'SPECULATION' | 'MID_TERM' | 'LONG_TERM';

const HORIZON_LABELS: Record<Horizon, string> = {
  SPECULATION: 'Short-term speculation (days to weeks)',
  MID_TERM: 'Mid-term investing (weeks to months)',
  LONG_TERM: 'Long-term investing (months to years)',
};

@Injectable()
export class GeminiAnalysisService {
  private readonly logger = new Logger(GeminiAnalysisService.name);
  private genAI: GoogleGenerativeAI | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly technicalAnalysis: TechnicalAnalysisService,
    private readonly newsScraper: NewsScraperService,
  ) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.logger.log('Gemini AI initialized');
    } else {
      this.logger.warn('GEMINI_API_KEY not set — AI signals will use technical analysis fallback');
    }
  }

  async analyzeStock(symbol: string, horizon: Horizon = 'MID_TERM'): Promise<AISignalResult> {
    const upperSymbol = symbol.toUpperCase();

    // Check cache first (2h TTL)
    const cacheKey = `ai-signal:${upperSymbol}:${horizon}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Gather all data in parallel
    const [technicalData, stock, sectorStocks, news, marketNews, externalSignals] = await Promise.all([
      this.technicalAnalysis.analyze(upperSymbol).catch(() => null),
      this.prisma.stock.findUnique({ where: { symbol: upperSymbol } }),
      this.getSectorComparison(upperSymbol),
      this.newsScraper.getNewsForStock(upperSymbol).catch(() => []),
      this.newsScraper.getMarketNews().catch(() => []),
      this.getExternalSignals(upperSymbol),
    ]);

    if (!technicalData || technicalData.error) {
      return this.buildFallbackResult(upperSymbol, horizon, externalSignals);
    }

    // If Gemini is not available, use enhanced technical fallback
    if (!this.genAI) {
      return this.buildEnhancedTechnicalResult(technicalData, stock, sectorStocks, horizon, externalSignals);
    }

    try {
      const result = await this.callGemini(
        upperSymbol, technicalData, stock, sectorStocks, news, marketNews, horizon, externalSignals,
      );

      // Cache for 2 hours
      await this.redis.setex(cacheKey, 7200, JSON.stringify(result));
      return result;
    } catch (err) {
      this.logger.error(`Gemini analysis failed for ${upperSymbol}: ${(err as Error).message}`);
      return this.buildEnhancedTechnicalResult(technicalData, stock, sectorStocks, horizon, externalSignals);
    }
  }

  private async callGemini(
    symbol: string,
    technical: any,
    stock: any,
    sectorData: { avgPE: number | null; stockCount: number },
    news: any[],
    marketNews: any[],
    horizon: Horizon,
    externalSignals: any,
  ): Promise<AISignalResult> {
    const model = this.genAI!.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const priceHistory = technical.priceHistory
      ?.slice(-30)
      .map((p: any) => `${p.timestamp.split('T')[0]}: ${p.price}`)
      .join('\n') ?? 'N/A';

    const newsText = [...news, ...marketNews]
      .slice(0, 10)
      .map((n: any) => `- ${n.title} (${n.source})`)
      .join('\n') || 'No recent news available';

    const prompt = `You are an expert Egyptian stock market (EGX) analyst. Provide a precise trading recommendation based on comprehensive analysis.

STOCK: ${symbol} - ${stock?.name ?? 'Unknown'}
SECTOR: ${stock?.sector ?? 'Unknown'}
CURRENT PRICE: ${technical.currentPrice} EGP
P/E RATIO: ${stock?.pe ?? 'N/A'}${sectorData.avgPE ? ` (Sector average: ${sectorData.avgPE.toFixed(2)}, ${sectorData.stockCount} stocks)` : ''}
MARKET CAP: ${stock?.marketCap ?? 'N/A'}

TECHNICAL INDICATORS:
- RSI(14): ${technical.indicators.rsi14.value ?? 'N/A'} (${technical.indicators.rsi14.zone})
- MACD: ${technical.indicators.macd.value ?? 'N/A'} vs Signal: ${technical.indicators.macd.signal ?? 'N/A'} (${technical.indicators.macd.trend})
- SMA20: ${technical.indicators.sma20 ?? 'N/A'}
- SMA50: ${technical.indicators.sma50 ?? 'N/A'}
- SMA200: ${technical.indicators.sma200 ?? 'N/A'}
- Bollinger Bands: Upper=${technical.indicators.bollingerBands.upper ?? 'N/A'}, Middle=${technical.indicators.bollingerBands.middle ?? 'N/A'}, Lower=${technical.indicators.bollingerBands.lower ?? 'N/A'}
- %B: ${technical.indicators.bollingerBands.percentB ?? 'N/A'}
- ROC(10): ${technical.indicators.roc10 ?? 'N/A'}
- Momentum(20): ${technical.indicators.momentum20 ?? 'N/A'}

TREND ANALYSIS:
- Short-term: ${technical.trendAnalysis.shortTerm}
- Medium-term: ${technical.trendAnalysis.mediumTerm}
- Long-term: ${technical.trendAnalysis.longTerm}
- Golden Cross: ${technical.trendAnalysis.goldenCross ? 'YES' : 'No'}
- Death Cross: ${technical.trendAnalysis.deathCross ? 'YES' : 'No'}

SUPPORT & RESISTANCE:
- Supports: ${technical.supportResistance.supports.join(', ') || 'N/A'}
- Resistances: ${technical.supportResistance.resistances.join(', ') || 'N/A'}

EXISTING TECHNICAL SIGNAL: ${technical.overallSignal.action} (score: ${technical.overallSignal.score}, confidence: ${technical.overallSignal.confidence})
EGXPILOT SIGNALS: Daily=${externalSignals?.daily ?? 'N/A'}, Weekly=${externalSignals?.weekly ?? 'N/A'}, Monthly=${externalSignals?.monthly ?? 'N/A'}

PRICE HISTORY (last 30 data points):
${priceHistory}

RECENT NEWS:
${newsText}

INVESTMENT HORIZON: ${HORIZON_LABELS[horizon]}

Based on ALL the above data, provide your analysis. Consider:
1. Technical indicator convergence/divergence
2. Fundamental valuation vs sector
3. Price momentum and trend strength
4. Support/resistance proximity
5. News sentiment impact
6. Risk/reward for the specified investment horizon

${horizon === 'SPECULATION' ? 'Focus on short-term momentum, RSI extremes, MACD crossovers, and immediate price action.' : ''}
${horizon === 'MID_TERM' ? 'Balance technical and fundamental factors. Consider trend sustainability and sector positioning.' : ''}
${horizon === 'LONG_TERM' ? 'Emphasize fundamentals (P/E vs sector), long-term trend (SMA200), sector growth, and structural factors.' : ''}

Respond ONLY with valid JSON (no markdown, no code blocks):
{"signal":"Strong Buy|Buy|Neutral|Sell|Strong Sell","confidence":"High|Medium|Low","score":<number -100 to 100>,"reasons":["reason1","reason2","reason3","reason4","reason5"],"summary":"one concise sentence","risks":["risk1","risk2"],"targetAction":"specific actionable advice for this horizon"}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Parse JSON — handle potential markdown wrapping
    const jsonStr = text.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    // Validate and normalize
    const validSignals = ['Strong Buy', 'Buy', 'Neutral', 'Sell', 'Strong Sell'];
    const validConfidence = ['High', 'Medium', 'Low'];

    return {
      signal: validSignals.includes(parsed.signal) ? parsed.signal : 'Neutral',
      confidence: validConfidence.includes(parsed.confidence) ? parsed.confidence : 'Medium',
      score: Math.max(-100, Math.min(100, Number(parsed.score) || 0)),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 7).map(String) : [],
      summary: String(parsed.summary || ''),
      risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 4).map(String) : [],
      targetAction: String(parsed.targetAction || ''),
      horizon,
      source: 'ai',
      externalSignals,
    };
  }

  private async getSectorComparison(symbol: string): Promise<{ avgPE: number | null; stockCount: number }> {
    const stock = await this.prisma.stock.findUnique({ where: { symbol }, select: { sector: true } });
    if (!stock?.sector) return { avgPE: null, stockCount: 0 };

    const result = await this.prisma.stock.aggregate({
      where: { sector: stock.sector, pe: { not: null } },
      _avg: { pe: true },
      _count: true,
    });

    return {
      avgPE: result._avg.pe ? parseFloat(result._avg.pe.toString()) : null,
      stockCount: result._count,
    };
  }

  private async getExternalSignals(symbol: string) {
    try {
      const priceMap = await this.redis.hgetall('market:prices');
      const data = priceMap[symbol] ? JSON.parse(priceMap[symbol]) : null;
      return data?.signals ?? { daily: null, weekly: null, monthly: null };
    } catch {
      return { daily: null, weekly: null, monthly: null };
    }
  }

  /**
   * Enhanced technical analysis fallback when Gemini is unavailable.
   * Uses the existing scoring + fundamental data for richer basis text.
   */
  private buildEnhancedTechnicalResult(
    technical: any,
    stock: any,
    sectorData: { avgPE: number | null; stockCount: number },
    horizon: Horizon,
    externalSignals: any,
  ): AISignalResult {
    const sig = technical.overallSignal;
    const ind = technical.indicators;
    const trend = technical.trendAnalysis;

    // Build detailed reasons with actual values
    const reasons: string[] = [];

    if (ind.rsi14.value != null) {
      reasons.push(`RSI at ${ind.rsi14.value} — ${ind.rsi14.zone === 'oversold' ? 'oversold, potential bounce' : ind.rsi14.zone === 'overbought' ? 'overbought, potential pullback' : 'neutral zone'}`);
    }
    if (ind.macd.value != null) {
      reasons.push(`MACD ${ind.macd.trend} — MACD: ${ind.macd.value}, Signal: ${ind.macd.signal}`);
    }
    if (ind.sma200 != null) {
      const pctVs200 = trend.priceVsSma200;
      reasons.push(`Price ${pctVs200 > 0 ? 'above' : 'below'} SMA200 by ${Math.abs(pctVs200)}% — ${pctVs200 > 0 ? 'long-term bullish' : 'long-term bearish'}`);
    }
    if (trend.goldenCross) reasons.push('Golden Cross detected — strong bullish signal');
    if (trend.deathCross) reasons.push('Death Cross detected — strong bearish signal');
    if (stock?.pe && sectorData.avgPE) {
      const pe = parseFloat(stock.pe.toString());
      const ratio = (pe / sectorData.avgPE * 100).toFixed(0);
      reasons.push(`P/E ${pe.toFixed(1)} vs sector avg ${sectorData.avgPE.toFixed(1)} (${Number(ratio) < 100 ? 'undervalued' : 'overvalued'} at ${ratio}%)`);
    }
    if (ind.bollingerBands.percentB != null) {
      reasons.push(`Bollinger %B at ${ind.bollingerBands.percentB}% — ${ind.bollingerBands.percentB < 20 ? 'near lower band' : ind.bollingerBands.percentB > 80 ? 'near upper band' : 'mid-range'}`);
    }

    return {
      signal: sig.action,
      confidence: sig.confidence,
      score: sig.score,
      reasons: reasons.slice(0, 7),
      summary: `Technical analysis indicates ${sig.action} with ${sig.confidence.toLowerCase()} confidence (score: ${sig.score})`,
      risks: this.buildRisks(technical),
      targetAction: this.buildTargetAction(sig.action, horizon),
      horizon,
      source: 'technical-fallback',
      externalSignals,
    };
  }

  private buildFallbackResult(symbol: string, horizon: Horizon, externalSignals: any): AISignalResult {
    return {
      signal: 'Neutral',
      confidence: 'Low',
      score: 0,
      reasons: ['Insufficient data for comprehensive analysis'],
      summary: `Not enough price history to analyze ${symbol}`,
      risks: ['Limited data makes any recommendation unreliable'],
      targetAction: 'Wait for more price data before making a decision',
      horizon,
      source: 'technical-fallback',
      externalSignals,
    };
  }

  private buildRisks(technical: any): string[] {
    const risks: string[] = [];
    if (technical.indicators.rsi14.zone === 'overbought') risks.push('RSI overbought — reversal risk');
    if (technical.indicators.rsi14.zone === 'oversold') risks.push('Continued selling pressure possible');
    if (technical.trendAnalysis.deathCross) risks.push('Death Cross indicates potential sustained downtrend');
    if (technical.indicators.bollingerBands.bandwidth != null && technical.indicators.bollingerBands.bandwidth < 5) {
      risks.push('Low volatility — breakout in either direction possible');
    }
    if (!risks.length) risks.push('Standard market risk applies');
    return risks;
  }

  private buildTargetAction(signal: string, horizon: Horizon): string {
    const actions: Record<string, Record<Horizon, string>> = {
      'Strong Buy': {
        SPECULATION: 'Consider entering a position with tight stop-loss below nearest support',
        MID_TERM: 'Accumulate on dips, set stop-loss at key support level',
        LONG_TERM: 'Strong entry point for long-term portfolio building',
      },
      'Buy': {
        SPECULATION: 'Look for entry near support with defined risk/reward',
        MID_TERM: 'Gradual position building recommended',
        LONG_TERM: 'Good addition to portfolio at current levels',
      },
      'Neutral': {
        SPECULATION: 'Wait for clearer momentum signal before entering',
        MID_TERM: 'Hold existing positions, wait for trend confirmation',
        LONG_TERM: 'Monitor for better entry points or fundamental changes',
      },
      'Sell': {
        SPECULATION: 'Consider reducing exposure or setting tight stops',
        MID_TERM: 'Take partial profits and tighten stop-loss',
        LONG_TERM: 'Review position sizing and fundamentals',
      },
      'Strong Sell': {
        SPECULATION: 'Exit positions and consider short-term hedging',
        MID_TERM: 'Reduce exposure significantly',
        LONG_TERM: 'Reassess investment thesis, consider reducing position',
      },
    };
    return actions[signal]?.[horizon] ?? 'Monitor the stock and reassess';
  }
}
