import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { TechnicalAnalysisService } from '../technical-analysis.service';
import { NewsScraperService } from './news-scraper.service';
import { STRATEGY_PROMPTS } from './strategy-prompts';

export type StockStatus =
  | 'Hot'
  | 'Warming Up'
  | 'Neutral'
  | 'Cooling Down'
  | 'Cold';

export interface StrategyAnalysisResult {
  symbol: string;
  strategyId: string;
  signal: StockStatus;
  confidence: 'High' | 'Medium' | 'Low';
  currentPrice: number;
  stopLoss: number;
  supports: [number, number, number];
  resistances: [number, number, number];
  projection: {
    months3: { low: number; mid: number; high: number };
    months6: { low: number; mid: number; high: number };
  };
  analysis: string;
  reasons: string[];
  risks: string[];
  source: 'ai' | 'technical-fallback';
  aiProvider?: string;
}

export interface AISignalResult {
  signal: StockStatus;
  confidence: 'High' | 'Medium' | 'Low';
  score: number;
  reasons: string[];
  summary: string;
  risks: string[];
  outlook: string;
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

interface AIProvider {
  name: string;
  call: (prompt: string) => Promise<string>;
}

@Injectable()
export class GeminiAnalysisService {
  private readonly logger = new Logger(GeminiAnalysisService.name);
  private genAI: GoogleGenerativeAI | null = null;
  private readonly aiProviders: AIProvider[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly technicalAnalysis: TechnicalAnalysisService,
    private readonly newsScraper: NewsScraperService,
  ) {
    // Primary: Gemini
    const geminiKey = this.config.get<string>('GEMINI_API_KEY');
    if (geminiKey) {
      this.genAI = new GoogleGenerativeAI(geminiKey);
      this.aiProviders.push({
        name: 'Gemini',
        call: async (prompt: string) => {
          const model = this.genAI!.getGenerativeModel({
            model: 'gemini-2.0-flash',
          });
          const result = await model.generateContent(prompt);
          return result.response.text().trim();
        },
      });
      this.logger.log('Gemini AI initialized');
    }

    // Fallback 1: Groq (free tier — Llama 3.3 70B)
    const groqKey = this.config.get<string>('GROQ_API_KEY');
    if (groqKey) {
      this.aiProviders.push({
        name: 'Groq',
        call: async (prompt: string) => {
          const res = await fetch(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${groqKey}`,
              },
              body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 2048,
              }),
            },
          );
          if (!res.ok)
            throw new Error(`Groq ${res.status}: ${await res.text()}`);
          const json = await res.json();
          return json.choices[0].message.content.trim();
        },
      });
      this.logger.log('Groq AI initialized (fallback 1)');
    }

    // Fallback 2: OpenRouter (free models — Llama 3.1 8B free)
    const openRouterKey = this.config.get<string>('OPENROUTER_API_KEY');
    if (openRouterKey) {
      this.aiProviders.push({
        name: 'OpenRouter',
        call: async (prompt: string) => {
          const res = await fetch(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${openRouterKey}`,
                'HTTP-Referer': 'https://tradedesk.app',
              },
              body: JSON.stringify({
                model: 'nvidia/nemotron-3-super-120b-a12b:free',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 2048,
              }),
            },
          );
          if (!res.ok)
            throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
          const json = await res.json();
          return json.choices[0].message.content.trim();
        },
      });
      this.logger.log('OpenRouter AI initialized (fallback 2)');
    }

    if (this.aiProviders.length === 0) {
      this.logger.warn(
        'No AI API keys set — signals will use technical analysis fallback',
      );
    } else {
      this.logger.log(
        `AI provider chain: ${this.aiProviders.map((p) => p.name).join(' → ')}`,
      );
    }
  }

  /** Try each AI provider in order until one succeeds */
  private async callAIChain(
    prompt: string,
  ): Promise<{ text: string; provider: string }> {
    for (const provider of this.aiProviders) {
      try {
        const text = await provider.call(prompt);
        return { text, provider: provider.name };
      } catch (err) {
        const msg = (err as Error).message ?? '';
        this.logger.warn(`${provider.name} failed: ${msg.slice(0, 200)}`);
        // Continue to next provider
      }
    }
    throw new Error('All AI providers failed');
  }

  async analyzeStock(
    symbol: string,
    horizon: Horizon = 'MID_TERM',
  ): Promise<AISignalResult> {
    const upperSymbol = symbol.toUpperCase();

    // Check cache first (2h TTL)
    const cacheKey = `ai-signal:${upperSymbol}:${horizon}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Gather all data in parallel
    const [
      technicalData,
      stock,
      sectorStocks,
      news,
      marketNews,
      externalSignals,
    ] = await Promise.all([
      this.technicalAnalysis.analyze(upperSymbol).catch(() => null),
      this.prisma.stock.findUnique({ where: { symbol: upperSymbol } }),
      this.getSectorComparison(upperSymbol),
      this.newsScraper.getNewsForStock(upperSymbol).catch(() => []),
      this.newsScraper.getMarketNews().catch(() => []),
      this.getExternalSignals(upperSymbol),
    ]);

    const hasTechnical = technicalData && !technicalData.error;

    // If any AI provider is available, call it — even without technical data
    if (this.aiProviders.length > 0) {
      try {
        // Get live price from Redis if technical data is missing
        let livePrice: number | null = null;
        if (!hasTechnical) {
          const priceMap = await this.redis.hgetall('market:prices');
          const priceData = priceMap[upperSymbol]
            ? JSON.parse(priceMap[upperSymbol])
            : null;
          livePrice = priceData?.price ?? null;
        }

        const result = await this.callGemini(
          upperSymbol,
          hasTechnical ? technicalData : null,
          stock,
          sectorStocks,
          news,
          marketNews,
          horizon,
          externalSignals,
          livePrice,
        );

        // Cache for 2 hours
        await this.redis.setex(cacheKey, 7200, JSON.stringify(result));
        return result;
      } catch (err) {
        this.logger.error(
          `Gemini analysis failed for ${upperSymbol}: ${(err as Error).message}`,
        );
        // Fall through to technical fallback or basic fallback
      }
    }

    // Fallback: use technical analysis if available
    if (hasTechnical) {
      return this.buildEnhancedTechnicalResult(
        technicalData,
        stock,
        sectorStocks,
        horizon,
        externalSignals,
      );
    }

    return this.buildFallbackResult(upperSymbol, horizon, externalSignals);
  }

  private async gatherStockData(symbol: string) {
    const upperSymbol = symbol.toUpperCase();
    const [
      technicalData,
      stock,
      sectorStocks,
      news,
      marketNews,
      externalSignals,
    ] = await Promise.all([
      this.technicalAnalysis.analyze(upperSymbol).catch(() => null),
      this.prisma.stock.findUnique({ where: { symbol: upperSymbol } }),
      this.getSectorComparison(upperSymbol),
      this.newsScraper.getNewsForStock(upperSymbol).catch(() => []),
      this.newsScraper.getMarketNews().catch(() => []),
      this.getExternalSignals(upperSymbol),
    ]);

    let livePrice: number | null = null;
    const hasTechnical = technicalData && !technicalData.error;
    if (!hasTechnical) {
      const priceMap = await this.redis.hgetall('market:prices');
      const priceData = priceMap[upperSymbol]
        ? JSON.parse(priceMap[upperSymbol])
        : null;
      livePrice = priceData?.price ?? null;
    }

    return {
      technicalData,
      stock,
      sectorStocks,
      news,
      marketNews,
      externalSignals,
      hasTechnical,
      livePrice,
      upperSymbol,
    };
  }

  async analyzeStrategy(
    strategyId: string,
    symbols: string[],
    horizon: Horizon = 'MID_TERM',
  ): Promise<StrategyAnalysisResult[]> {
    const strategy = STRATEGY_PROMPTS[strategyId];
    if (!strategy) {
      throw new Error(`Unknown strategy: ${strategyId}`);
    }

    const results: StrategyAnalysisResult[] = [];

    for (const symbol of symbols) {
      const upperSymbol = symbol.toUpperCase();
      const cacheKey = `strategy:${strategyId}:${upperSymbol}:${horizon}`;
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        results.push(JSON.parse(cached));
        continue;
      }

      try {
        const data = await this.gatherStockData(upperSymbol);
        const currentPrice = data.hasTechnical
          ? data.technicalData!.currentPrice
          : (data.livePrice ?? 0);

        if (this.aiProviders.length > 0) {
          try {
            const result = await this.callStrategyAI(
              strategyId,
              strategy,
              data,
              horizon,
              currentPrice as number,
            );
            await this.redis.setex(cacheKey, 7200, JSON.stringify(result));
            results.push(result);
            continue;
          } catch (err) {
            this.logger.error(
              `All AI providers failed for ${upperSymbol}: ${(err as Error).message}`,
            );
          }
        }

        // Fallback: use technical analysis data directly (short cache so retries work after quota resets)
        const fallback = this.buildStrategyFallback(
          strategyId,
          data,
          currentPrice as number,
        );
        await this.redis.setex(cacheKey, 300, JSON.stringify(fallback)); // 5 min cache for fallbacks
        results.push(fallback);
      } catch (err) {
        this.logger.error(
          `Strategy analysis failed for ${upperSymbol}: ${(err as Error).message}`,
        );
        results.push({
          symbol: upperSymbol,
          strategyId,
          signal: 'Neutral',
          confidence: 'Low',
          currentPrice: 0,
          stopLoss: 0,
          supports: [0, 0, 0],
          resistances: [0, 0, 0],
          projection: {
            months3: { low: 0, mid: 0, high: 0 },
            months6: { low: 0, mid: 0, high: 0 },
          },
          analysis:
            'Unable to analyze this stock. Insufficient data available.',
          reasons: ['Analysis failed due to insufficient data'],
          risks: ['No data available for risk assessment'],
          source: 'technical-fallback',
        });
      }
    }

    return results;
  }

  private async callStrategyAI(
    strategyId: string,
    strategy: { name: string; systemPrompt: string },
    data: Awaited<ReturnType<GeminiAnalysisService['gatherStockData']>>,
    horizon: Horizon,
    currentPrice: number,
  ): Promise<StrategyAnalysisResult> {
    const {
      technicalData,
      stock,
      sectorStocks,
      news,
      marketNews,
      externalSignals,
      hasTechnical,
      upperSymbol,
    } = data;

    let technicalSection = '';
    if (hasTechnical && technicalData) {
      const ind = technicalData.indicators!;
      const trend = technicalData.trendAnalysis!;
      const sr = technicalData.supportResistance!;
      const sig = technicalData.overallSignal!;
      technicalSection = `
TECHNICAL INDICATORS:
- RSI(14): ${ind.rsi14.value ?? 'N/A'} (${ind.rsi14.zone})
- MACD: ${ind.macd.value ?? 'N/A'} vs Signal: ${ind.macd.signal ?? 'N/A'} (${ind.macd.trend})
- SMA20: ${ind.sma20 ?? 'N/A'}, SMA50: ${ind.sma50 ?? 'N/A'}, SMA200: ${ind.sma200 ?? 'N/A'}
- Bollinger Bands: Upper=${ind.bollingerBands.upper ?? 'N/A'}, Middle=${ind.bollingerBands.middle ?? 'N/A'}, Lower=${ind.bollingerBands.lower ?? 'N/A'}
- ROC(10): ${ind.roc10 ?? 'N/A'}, Momentum(20): ${ind.momentum20 ?? 'N/A'}

TREND ANALYSIS:
- Short-term: ${trend.shortTerm}, Medium-term: ${trend.mediumTerm}, Long-term: ${trend.longTerm}
- Golden Cross: ${trend.goldenCross ? 'YES' : 'No'}, Death Cross: ${trend.deathCross ? 'YES' : 'No'}

SUPPORT & RESISTANCE:
- Supports: ${sr.supports.join(', ') || 'N/A'}
- Resistances: ${sr.resistances.join(', ') || 'N/A'}

TECHNICAL SIGNAL: ${sig.action} (score: ${sig.score})`;
    }

    const priceHistory =
      hasTechnical && technicalData
        ? (technicalData.priceHistory
            ?.slice(-30)
            .map((p: any) => `${p.timestamp.split('T')[0]}: ${p.price}`)
            .join('\n') ?? 'N/A')
        : 'N/A';

    const newsText =
      [...(news ?? []), ...(marketNews ?? [])]
        .slice(0, 8)
        .map((n: any) => `- ${n.title} (${n.source})`)
        .join('\n') || 'No recent news';

    const prompt = `${strategy.systemPrompt}

STOCK: ${upperSymbol} - ${stock?.name ?? 'Unknown'}
SECTOR: ${stock?.sector ?? 'Unknown'}
CURRENT PRICE: ${currentPrice} EGP
P/E RATIO: ${stock?.pe ?? 'N/A'}${sectorStocks.avgPE ? ` (Sector avg: ${sectorStocks.avgPE.toFixed(2)})` : ''}
MARKET CAP: ${stock?.marketCap ?? 'N/A'}
${technicalSection}

EGXPILOT SIGNALS: Daily=${externalSignals?.daily ?? 'N/A'}, Weekly=${externalSignals?.weekly ?? 'N/A'}, Monthly=${externalSignals?.monthly ?? 'N/A'}

PRICE HISTORY (last 30 points):
${priceHistory}

RECENT NEWS:
${newsText}

INVESTMENT HORIZON: ${HORIZON_LABELS[horizon]}

Based on your ${strategy.name} methodology and ALL the above data, provide your complete status assessment. Do NOT provide buy/sell recommendations — only describe the stock's condition and outlook.

You MUST respond ONLY with valid JSON (no markdown, no code blocks) in this exact format:
{
  "signal": "Hot|Warming Up|Neutral|Cooling Down|Cold",
  "confidence": "High|Medium|Low",
  "stopLoss": <number - price level for stop loss>,
  "supports": [<number>, <number>, <number>],
  "resistances": [<number>, <number>, <number>],
  "projection": {
    "months3": { "low": <number>, "mid": <number>, "high": <number> },
    "months6": { "low": <number>, "mid": <number>, "high": <number> }
  },
  "analysis": "<detailed 2-3 paragraph analysis explaining the stock's current status, key indicators, and market positioning — NO buy/sell recommendations>",
  "reasons": ["reason1", "reason2", "reason3", "reason4", "reason5"],
  "risks": ["risk1", "risk2", "risk3"]
}

IMPORTANT:
- All price values must be realistic numbers in EGP based on the current price of ${currentPrice} EGP
- supports should be 3 price levels BELOW current price, ordered from nearest to farthest
- resistances should be 3 price levels ABOVE current price, ordered from nearest to farthest
- stopLoss should be below the lowest support
- projection ranges should be realistic based on the stock's historical volatility and your analysis`;

    const { text: rawText, provider: aiProvider } =
      await this.callAIChain(prompt);
    this.logger.log(
      `Strategy analysis for ${upperSymbol} powered by ${aiProvider}`,
    );
    const jsonStr = rawText
      .replace(/^```json?\s*/, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(jsonStr);

    const validSignals: StockStatus[] = [
      'Hot',
      'Warming Up',
      'Neutral',
      'Cooling Down',
      'Cold',
    ];
    const validConfidence = ['High', 'Medium', 'Low'];

    return {
      symbol: upperSymbol,
      strategyId,
      signal: validSignals.includes(parsed.signal) ? parsed.signal : 'Neutral',
      confidence: validConfidence.includes(parsed.confidence)
        ? parsed.confidence
        : 'Medium',
      currentPrice,
      stopLoss: Number(parsed.stopLoss) || currentPrice * 0.9,
      supports: this.normalizeThreeLevels(
        parsed.supports,
        currentPrice,
        'support',
      ),
      resistances: this.normalizeThreeLevels(
        parsed.resistances,
        currentPrice,
        'resistance',
      ),
      projection: {
        months3: {
          low: Number(parsed.projection?.months3?.low) || currentPrice * 0.9,
          mid: Number(parsed.projection?.months3?.mid) || currentPrice,
          high: Number(parsed.projection?.months3?.high) || currentPrice * 1.1,
        },
        months6: {
          low: Number(parsed.projection?.months6?.low) || currentPrice * 0.85,
          mid: Number(parsed.projection?.months6?.mid) || currentPrice * 1.05,
          high: Number(parsed.projection?.months6?.high) || currentPrice * 1.2,
        },
      },
      analysis: String(parsed.analysis || ''),
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.slice(0, 7).map(String)
        : [],
      risks: Array.isArray(parsed.risks)
        ? parsed.risks.slice(0, 5).map(String)
        : [],
      source: 'ai',
      aiProvider,
    };
  }

  private normalizeThreeLevels(
    arr: unknown,
    currentPrice: number,
    type: 'support' | 'resistance',
  ): [number, number, number] {
    if (Array.isArray(arr) && arr.length >= 3) {
      const nums = arr
        .slice(0, 3)
        .map(Number)
        .filter((n) => n > 0);
      if (nums.length === 3)
        return nums.sort((a, b) => (type === 'support' ? b - a : a - b)) as [
          number,
          number,
          number,
        ];
    }
    // Fallback: generate levels from current price
    if (type === 'support') {
      return [
        +(currentPrice * 0.97).toFixed(2),
        +(currentPrice * 0.94).toFixed(2),
        +(currentPrice * 0.9).toFixed(2),
      ];
    }
    return [
      +(currentPrice * 1.03).toFixed(2),
      +(currentPrice * 1.06).toFixed(2),
      +(currentPrice * 1.1).toFixed(2),
    ];
  }

  private buildStrategyFallback(
    strategyId: string,
    data: Awaited<ReturnType<GeminiAnalysisService['gatherStockData']>>,
    currentPrice: number,
  ): StrategyAnalysisResult {
    const { technicalData, hasTechnical, upperSymbol } = data;

    let supports: [number, number, number];
    let resistances: [number, number, number];
    let signal: StrategyAnalysisResult['signal'] = 'Neutral';
    let confidence: StrategyAnalysisResult['confidence'] = 'Low';

    if (hasTechnical && technicalData) {
      const s = technicalData.supportResistance!.supports;
      const r = technicalData.supportResistance!.resistances;
      supports =
        s.length >= 3
          ? [s[0], s[1], s[2]]
          : this.normalizeThreeLevels(s, currentPrice, 'support');
      resistances =
        r.length >= 3
          ? [r[0], r[1], r[2]]
          : this.normalizeThreeLevels(r, currentPrice, 'resistance');
      signal = technicalData.overallSignal!.action;
      confidence = technicalData.overallSignal!.confidence;
    } else {
      supports = this.normalizeThreeLevels([], currentPrice, 'support');
      resistances = this.normalizeThreeLevels([], currentPrice, 'resistance');
    }

    const stopLoss = +(supports[2] * 0.98).toFixed(2);

    return {
      symbol: upperSymbol,
      strategyId,
      signal,
      confidence,
      currentPrice,
      stopLoss,
      supports,
      resistances,
      projection: {
        months3: {
          low: +(currentPrice * 0.9).toFixed(2),
          mid: +(currentPrice * 1.0).toFixed(2),
          high: +(currentPrice * 1.1).toFixed(2),
        },
        months6: {
          low: +(currentPrice * 0.85).toFixed(2),
          mid: +(currentPrice * 1.05).toFixed(2),
          high: +(currentPrice * 1.2).toFixed(2),
        },
      },
      analysis: `Technical analysis fallback for ${upperSymbol}. The AI analysis service is currently unavailable. Based on technical indicators, the status is ${signal} with ${confidence} confidence. Key support and resistance levels are provided for reference.`,
      reasons:
        hasTechnical && technicalData
          ? [
              `Technical signal: ${signal} (score: ${technicalData.overallSignal!.score})`,
              `Trend: ${technicalData.trendAnalysis!.shortTerm} short-term`,
            ]
          : ['Insufficient data for detailed analysis'],
      risks: [
        'AI analysis unavailable — results are based on technical indicators only',
      ],
      source: 'technical-fallback',
    };
  }

  private async callGemini(
    symbol: string,
    technical: any | null,
    stock: any,
    sectorData: { avgPE: number | null; stockCount: number },
    news: any[],
    marketNews: any[],
    horizon: Horizon,
    externalSignals: any,
    livePrice?: number | null,
  ): Promise<AISignalResult> {
    const currentPrice = technical?.currentPrice ?? livePrice ?? 'N/A';

    const priceHistory =
      technical?.priceHistory
        ?.slice(-30)
        .map((p: any) => `${p.timestamp.split('T')[0]}: ${p.price}`)
        .join('\n') ?? 'No price history available yet';

    const newsText =
      [...news, ...marketNews]
        .slice(0, 10)
        .map((n: any) => `- ${n.title} (${n.source})`)
        .join('\n') || 'No recent news available';

    // Build technical section dynamically
    let technicalSection: string;
    if (technical) {
      technicalSection = `TECHNICAL INDICATORS:
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

EXISTING TECHNICAL SIGNAL: ${technical.overallSignal.action} (score: ${technical.overallSignal.score}, confidence: ${technical.overallSignal.confidence})`;
    } else {
      technicalSection = `TECHNICAL INDICATORS: Not available yet (insufficient price history)
NOTE: Base your analysis on fundamentals, EgxPilot signals, sector data, news, and current price. Be explicit that technical analysis is limited.`;
    }

    const prompt = `You are an expert Egyptian stock market (EGX) analyst. Provide a precise status assessment of the stock based on ALL available data. Do NOT provide buy/sell recommendations — only describe the stock's current condition and outlook.

STOCK: ${symbol} - ${stock?.name ?? 'Unknown'}
SECTOR: ${stock?.sector ?? 'Unknown'}
CURRENT PRICE: ${currentPrice} EGP
P/E RATIO: ${stock?.pe ?? 'N/A'}${sectorData.avgPE ? ` (Sector average: ${sectorData.avgPE.toFixed(2)}, ${sectorData.stockCount} stocks)` : ''}
MARKET CAP: ${stock?.marketCap ?? 'N/A'}

${technicalSection}

EGXPILOT SIGNALS: Daily=${externalSignals?.daily ?? 'N/A'}, Weekly=${externalSignals?.weekly ?? 'N/A'}, Monthly=${externalSignals?.monthly ?? 'N/A'}

PRICE HISTORY (last 30 data points):
${priceHistory}

RECENT NEWS:
${newsText}

INVESTMENT HORIZON: ${HORIZON_LABELS[horizon]}

Based on ALL the above data, provide your analysis. Consider:
1. ${technical ? 'Technical indicator convergence/divergence' : 'EgxPilot signal consensus (daily/weekly/monthly agreement)'}
2. Fundamental valuation vs sector
3. ${technical ? 'Price momentum and trend strength' : 'Current price level and market sentiment'}
4. ${technical ? 'Support/resistance proximity' : 'Sector performance and positioning'}
5. News sentiment impact
6. Risk/reward for the specified investment horizon

${horizon === 'SPECULATION' ? 'Focus on short-term momentum, RSI extremes, MACD crossovers, and immediate price action.' : ''}
${horizon === 'MID_TERM' ? 'Balance technical and fundamental factors. Consider trend sustainability and sector positioning.' : ''}
${horizon === 'LONG_TERM' ? 'Emphasize fundamentals (P/E vs sector), long-term trend (SMA200), sector growth, and structural factors.' : ''}

Respond ONLY with valid JSON (no markdown, no code blocks):
{"signal":"Strongly Bullish|Bullish|Neutral|Bearish|Strongly Bearish","confidence":"High|Medium|Low","score":<number -100 to 100>,"reasons":["reason1","reason2","reason3","reason4","reason5"],"summary":"one concise sentence describing current stock status","risks":["risk1","risk2"],"outlook":"descriptive outlook for the stock over this horizon — do NOT provide buy/sell advice"}`;

    const { text: rawText, provider } = await this.callAIChain(prompt);
    this.logger.log(`Signal analysis for ${symbol} powered by ${provider}`);

    // Parse JSON — handle potential markdown wrapping
    const jsonStr = rawText
      .replace(/^```json?\s*/, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(jsonStr);

    // Validate and normalize
    const validSignals: StockStatus[] = [
      'Hot',
      'Warming Up',
      'Neutral',
      'Cooling Down',
      'Cold',
    ];
    const validConfidence = ['High', 'Medium', 'Low'];

    return {
      signal: validSignals.includes(parsed.signal) ? parsed.signal : 'Neutral',
      confidence: validConfidence.includes(parsed.confidence)
        ? parsed.confidence
        : 'Medium',
      score: Math.max(-100, Math.min(100, Number(parsed.score) || 0)),
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.slice(0, 7).map(String)
        : [],
      summary: String(parsed.summary || ''),
      risks: Array.isArray(parsed.risks)
        ? parsed.risks.slice(0, 4).map(String)
        : [],
      outlook: String(parsed.outlook || ''),
      horizon,
      source: 'ai',
      externalSignals,
    };
  }

  private async getSectorComparison(
    symbol: string,
  ): Promise<{ avgPE: number | null; stockCount: number }> {
    const stock = await this.prisma.stock.findUnique({
      where: { symbol },
      select: { sector: true },
    });
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
      reasons.push(
        `RSI at ${ind.rsi14.value} — ${ind.rsi14.zone === 'oversold' ? 'oversold, potential bounce' : ind.rsi14.zone === 'overbought' ? 'overbought, potential pullback' : 'neutral zone'}`,
      );
    }
    if (ind.macd.value != null) {
      reasons.push(
        `MACD ${ind.macd.trend} — MACD: ${ind.macd.value}, Signal: ${ind.macd.signal}`,
      );
    }
    if (ind.sma200 != null) {
      const pctVs200 = trend.priceVsSma200;
      reasons.push(
        `Price ${pctVs200 > 0 ? 'above' : 'below'} SMA200 by ${Math.abs(pctVs200)}% — ${pctVs200 > 0 ? 'long-term bullish' : 'long-term bearish'}`,
      );
    }
    if (trend.goldenCross)
      reasons.push('Golden Cross detected — strong bullish signal');
    if (trend.deathCross)
      reasons.push('Death Cross detected — strong bearish signal');
    if (stock?.pe && sectorData.avgPE) {
      const pe = parseFloat(stock.pe.toString());
      const ratio = ((pe / sectorData.avgPE) * 100).toFixed(0);
      reasons.push(
        `P/E ${pe.toFixed(1)} vs sector avg ${sectorData.avgPE.toFixed(1)} (${Number(ratio) < 100 ? 'undervalued' : 'overvalued'} at ${ratio}%)`,
      );
    }
    if (ind.bollingerBands.percentB != null) {
      reasons.push(
        `Bollinger %B at ${ind.bollingerBands.percentB}% — ${ind.bollingerBands.percentB < 20 ? 'near lower band' : ind.bollingerBands.percentB > 80 ? 'near upper band' : 'mid-range'}`,
      );
    }

    return {
      signal: sig.action,
      confidence: sig.confidence,
      score: sig.score,
      reasons: reasons.slice(0, 7),
      summary: `Technical analysis indicates ${sig.action} with ${sig.confidence.toLowerCase()} confidence (score: ${sig.score})`,
      risks: this.buildRisks(technical),
      outlook: this.buildOutlook(sig.action, horizon),
      horizon,
      source: 'technical-fallback',
      externalSignals,
    };
  }

  private buildFallbackResult(
    symbol: string,
    horizon: Horizon,
    externalSignals: any,
  ): AISignalResult {
    return {
      signal: 'Neutral',
      confidence: 'Low',
      score: 0,
      reasons: ['Insufficient data for comprehensive analysis'],
      summary: `Not enough price history to analyze ${symbol}`,
      risks: ['Limited data makes any recommendation unreliable'],
      outlook: 'Insufficient data to determine stock outlook',
      horizon,
      source: 'technical-fallback',
      externalSignals,
    };
  }

  private buildRisks(technical: any): string[] {
    const risks: string[] = [];
    if (technical.indicators.rsi14.zone === 'overbought')
      risks.push('RSI overbought — reversal risk');
    if (technical.indicators.rsi14.zone === 'oversold')
      risks.push('Continued selling pressure possible');
    if (technical.trendAnalysis.deathCross)
      risks.push('Death Cross indicates potential sustained downtrend');
    if (
      technical.indicators.bollingerBands.bandwidth != null &&
      technical.indicators.bollingerBands.bandwidth < 5
    ) {
      risks.push('Low volatility — breakout in either direction possible');
    }
    if (!risks.length) risks.push('Standard market risk applies');
    return risks;
  }

  private buildOutlook(signal: string, horizon: Horizon): string {
    const outlooks: Record<string, Record<Horizon, string>> = {
      Hot: {
        SPECULATION:
          'Strong short-term momentum with multiple bullish indicators converging',
        MID_TERM: 'Solid uptrend supported by both technicals and fundamentals',
        LONG_TERM:
          'Long-term indicators point to sustained strength and growth potential',
      },
      'Warming Up': {
        SPECULATION:
          'Early momentum building with improving short-term signals',
        MID_TERM: 'Gradual improvement in trend and sentiment indicators',
        LONG_TERM: 'Fundamentals improving with positive long-term trajectory',
      },
      Neutral: {
        SPECULATION: 'No clear short-term directional bias — mixed signals',
        MID_TERM: 'Sideways movement expected, awaiting catalyst for direction',
        LONG_TERM: 'Stable but lacking clear growth or decline catalysts',
      },
      'Cooling Down': {
        SPECULATION: 'Short-term momentum fading with weakening indicators',
        MID_TERM: 'Trend showing signs of deterioration across timeframes',
        LONG_TERM: 'Fundamental headwinds emerging, weakening outlook',
      },
      Cold: {
        SPECULATION:
          'Strong downward pressure with bearish indicator alignment',
        MID_TERM:
          'Sustained weakness across technical and fundamental measures',
        LONG_TERM: 'Structural challenges with prolonged negative outlook',
      },
    };
    return (
      outlooks[signal]?.[horizon] ?? 'Insufficient data to determine outlook'
    );
  }
}
