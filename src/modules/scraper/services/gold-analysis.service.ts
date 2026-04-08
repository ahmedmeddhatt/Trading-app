import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';

export type GoldSignalStatus =
  | 'Hot'
  | 'Warming Up'
  | 'Neutral'
  | 'Cooling Down'
  | 'Cold';

export interface GoldSignalResult {
  categoryId: string;
  signal: GoldSignalStatus;
  confidence: 'High' | 'Medium' | 'Low';
  score: number;
  reasons: string[];
  summary: string;
  risks: string[];
  outlook: string;
  horizon: string;
  buyVsSellSpread: number | null;
  globalCorrelation: string;
  source: 'ai' | 'trend-fallback';
  aiProvider?: string;
}

interface GoldLivePrice {
  buyPrice: number;
  sellPrice: number;
  changePercent: number;
  timestamp: string;
  source: string;
  globalSpotUsd: number | null;
}

interface GoldCategory {
  id: string;
  nameAr: string;
  nameEn: string;
  unit: string;
  purity: { toString(): string } | null;
}

type Horizon = 'SPECULATION' | 'MID_TERM' | 'LONG_TERM';

const HORIZON_LABELS: Record<Horizon, string> = {
  SPECULATION: 'Short-term trading (days to weeks)',
  MID_TERM: 'Mid-term holding (weeks to months)',
  LONG_TERM: 'Long-term investment (months to years)',
};

interface AIProvider {
  name: string;
  call: (prompt: string) => Promise<string>;
}

const GOLD_STRATEGY_PROMPTS: Record<string, { name: string; focus: string }> = {
  'gold-trend': {
    name: 'Price Trend Analysis',
    focus:
      'Analyze gold price trends, momentum, moving averages, and directional strength across timeframes.',
  },
  'gold-value': {
    name: 'Value & Premium Analysis',
    focus:
      'Analyze the dealer premium over spot price, buy/sell spread efficiency, and which karat offers the best value proposition.',
  },
  'gold-timing': {
    name: 'Entry/Exit Timing',
    focus:
      'Identify optimal entry and exit points based on price cycles, seasonal patterns, and current market positioning.',
  },
  'gold-macro': {
    name: 'Macro Factor Analysis',
    focus:
      'Analyze macroeconomic factors: Egyptian pound stability, inflation rates, USD/EGP trends, global monetary policy, and geopolitical risks.',
  },
  'gold-portfolio': {
    name: 'Portfolio Allocation',
    focus:
      'Evaluate gold as a portfolio component: optimal allocation percentage, diversification benefits, correlation with other Egyptian assets, and risk reduction.',
  },
};

@Injectable()
export class GoldAnalysisService {
  private readonly logger = new Logger(GoldAnalysisService.name);
  private genAI: GoogleGenerativeAI | null = null;
  private readonly aiProviders: AIProvider[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
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
    }

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
          const json = (await res.json()) as {
            choices: { message: { content: string } }[];
          };
          return json.choices[0].message.content.trim();
        },
      });
    }

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
          const json = (await res.json()) as {
            choices: { message: { content: string } }[];
          };
          return json.choices[0].message.content.trim();
        },
      });
    }
  }

  private async callAIChain(
    prompt: string,
  ): Promise<{ text: string; provider: string }> {
    for (const provider of this.aiProviders) {
      try {
        const text = await provider.call(prompt);
        return { text, provider: provider.name };
      } catch (err) {
        this.logger.warn(
          `${provider.name} failed: ${((err as Error).message ?? '').slice(0, 200)}`,
        );
      }
    }
    throw new Error('All AI providers failed');
  }

  async analyzeGold(
    categoryId: string,
    horizon: Horizon = 'MID_TERM',
  ): Promise<GoldSignalResult> {
    const cacheKey = `gold:analysis:${categoryId}:${horizon}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as GoldSignalResult;

    const category = await this.prisma.goldCategory.findUnique({
      where: { id: categoryId },
    });
    if (!category) {
      return this.buildFallbackResult(categoryId, horizon);
    }

    // Get current price from Redis
    const priceRaw = await this.redis.hget('market:gold:prices', categoryId);
    const livePrice: GoldLivePrice | null = priceRaw
      ? (JSON.parse(priceRaw) as GoldLivePrice)
      : null;

    // Get price history for trend analysis
    const history = await this.prisma.goldPriceHistory.findMany({
      where: { categoryId },
      orderBy: { timestamp: 'desc' },
      take: 30,
    });

    // Get all category prices for comparison
    const allPricesRaw = await this.redis.hgetall('market:gold:prices');
    const allPrices: Record<string, GoldLivePrice> = {};
    for (const [id, json] of Object.entries(allPricesRaw ?? {})) {
      try {
        allPrices[id] = JSON.parse(json) as GoldLivePrice;
      } catch {
        /* skip */
      }
    }

    if (this.aiProviders.length > 0) {
      try {
        const result = await this.callGoldAI(
          category,
          livePrice,
          history,
          allPrices,
          horizon,
        );
        await this.redis.setex(cacheKey, 14400, JSON.stringify(result)); // 4h cache
        return result;
      } catch (err) {
        this.logger.error(
          `Gold AI analysis failed for ${categoryId}: ${(err as Error).message}`,
        );
      }
    }

    // Fallback: trend-based analysis
    const fallback = this.buildTrendFallback(
      categoryId,
      category,
      livePrice,
      history,
      horizon,
    );
    await this.redis.setex(cacheKey, 3600, JSON.stringify(fallback)); // 1h cache for fallback
    return fallback;
  }

  async analyzeMultiple(
    categoryIds: string[],
    horizon: Horizon = 'MID_TERM',
  ): Promise<GoldSignalResult[]> {
    const results: GoldSignalResult[] = [];
    for (const id of categoryIds) {
      results.push(await this.analyzeGold(id, horizon));
    }
    return results;
  }

  private async callGoldAI(
    category: GoldCategory,
    livePrice: GoldLivePrice | null,
    history: {
      timestamp: Date;
      buyPrice: { toNumber(): number; toString(): string };
      sellPrice: { toNumber(): number; toString(): string };
    }[],
    allPrices: Record<string, GoldLivePrice>,
    horizon: Horizon,
  ): Promise<GoldSignalResult> {
    const buyPrice = livePrice?.buyPrice ?? 'N/A';
    const sellPrice = livePrice?.sellPrice ?? 'N/A';
    const globalSpot = livePrice?.globalSpotUsd ?? 'N/A';
    const spread = livePrice
      ? (
          ((livePrice.buyPrice - livePrice.sellPrice) / livePrice.sellPrice) *
          100
        ).toFixed(2)
      : 'N/A';

    const historyText =
      history.length > 0
        ? history
            .slice(0, 20)
            .map(
              (h) =>
                `${h.timestamp.toISOString().split('T')[0]}: Buy=${String(h.buyPrice)} Sell=${String(h.sellPrice)}`,
            )
            .join('\n')
        : 'No price history available yet';

    // Build comparison of all karats
    const comparisonText =
      Object.entries(allPrices)
        .map(
          ([id, p]) =>
            `${id}: Buy=${p.buyPrice} Sell=${p.sellPrice} (${(((p.buyPrice - p.sellPrice) / p.sellPrice) * 100).toFixed(1)}% spread)`,
        )
        .join('\n') || 'No comparison data';

    const prompt = `You are an expert Egyptian gold market analyst. Provide a precise analysis of this gold category based on ALL available data. Do NOT provide buy/sell recommendations — only describe the current market condition and outlook.

GOLD CATEGORY: ${category.id} - ${category.nameEn} (${category.nameAr})
UNIT: ${category.unit}
PURITY: ${category.purity?.toString() ?? 'N/A'}

CURRENT PRICES (EGP):
- Buy Price (what you pay): ${buyPrice} EGP
- Sell Price (what you receive): ${sellPrice} EGP
- Dealer Spread: ${spread}%
- Global Gold Spot: $${globalSpot} USD/oz

ALL KARAT COMPARISON:
${comparisonText}

PRICE HISTORY (recent):
${historyText}

INVESTMENT HORIZON: ${HORIZON_LABELS[horizon]}

Analyze considering:
1. Price trend direction and momentum
2. Buy/sell spread efficiency (lower = better for investors)
3. Karat value comparison (which karat has best premium-adjusted value)
4. Egyptian pound factors (inflation, devaluation expectations, EGP/USD)
5. Global gold correlation (XAU/USD impact)
6. Timing within the horizon
${horizon === 'SPECULATION' ? '7. Short-term price swings and entry opportunities' : ''}
${horizon === 'MID_TERM' ? '7. Medium-term trends and seasonal patterns' : ''}
${horizon === 'LONG_TERM' ? '7. Long-term wealth preservation vs inflation and alternative stores of value' : ''}

Respond ONLY with valid JSON (no markdown, no code blocks):
{"signal":"Hot|Warming Up|Neutral|Cooling Down|Cold","confidence":"High|Medium|Low","score":<number -100 to 100>,"reasons":["reason1","reason2","reason3","reason4","reason5"],"summary":"one concise sentence describing current gold market status","risks":["risk1","risk2","risk3"],"outlook":"descriptive outlook for this gold category over this horizon","globalCorrelation":"how this category tracks global gold price and what factors cause divergence"}`;

    const { text: rawText, provider } = await this.callAIChain(prompt);
    this.logger.log(`Gold analysis for ${category.id} powered by ${provider}`);

    const jsonStr = rawText
      .replace(/^```json?\s*/, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(jsonStr) as {
      signal?: string;
      confidence?: string;
      score?: number;
      reasons?: string[];
      summary?: string;
      risks?: string[];
      outlook?: string;
      globalCorrelation?: string;
    };

    const validSignals: GoldSignalStatus[] = [
      'Hot',
      'Warming Up',
      'Neutral',
      'Cooling Down',
      'Cold',
    ];

    return {
      categoryId: category.id,
      signal: validSignals.includes(parsed.signal as GoldSignalStatus)
        ? (parsed.signal as GoldSignalStatus)
        : 'Neutral',
      confidence: (['High', 'Medium', 'Low'] as const).includes(
        parsed.confidence as 'High' | 'Medium' | 'Low',
      )
        ? (parsed.confidence as 'High' | 'Medium' | 'Low')
        : 'Medium',
      score: Math.max(-100, Math.min(100, Number(parsed.score) || 0)),
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.slice(0, 7).map(String)
        : [],
      summary: String(parsed.summary || ''),
      risks: Array.isArray(parsed.risks)
        ? parsed.risks.slice(0, 5).map(String)
        : [],
      outlook: String(parsed.outlook || ''),
      horizon,
      buyVsSellSpread: livePrice
        ? +(
            ((livePrice.buyPrice - livePrice.sellPrice) / livePrice.sellPrice) *
            100
          ).toFixed(2)
        : null,
      globalCorrelation: String(parsed.globalCorrelation || ''),
      source: 'ai',
      aiProvider: provider,
    };
  }

  private buildTrendFallback(
    categoryId: string,
    category: GoldCategory,
    livePrice: GoldLivePrice | null,
    history: { sellPrice: { toNumber(): number; toString(): string } }[],
    horizon: Horizon,
  ): GoldSignalResult {
    let signal: GoldSignalStatus = 'Neutral';
    let score = 0;
    const reasons: string[] = [];

    if (history.length >= 2) {
      const recent = Number(history[0].sellPrice.toNumber());
      const older = Number(history[history.length - 1].sellPrice.toNumber());
      const trendPct = ((recent - older) / older) * 100;

      if (trendPct > 3) {
        signal = 'Hot';
        score = 60;
        reasons.push(`Price up ${trendPct.toFixed(1)}% over recent period`);
      } else if (trendPct > 1) {
        signal = 'Warming Up';
        score = 30;
        reasons.push(`Price up ${trendPct.toFixed(1)}% — moderate uptrend`);
      } else if (trendPct < -3) {
        signal = 'Cold';
        score = -60;
        reasons.push(
          `Price down ${Math.abs(trendPct).toFixed(1)}% — strong downtrend`,
        );
      } else if (trendPct < -1) {
        signal = 'Cooling Down';
        score = -30;
        reasons.push(
          `Price down ${Math.abs(trendPct).toFixed(1)}% — mild downtrend`,
        );
      } else {
        reasons.push('Price relatively stable in recent period');
      }
    } else {
      reasons.push('Insufficient price history for trend analysis');
    }

    if (livePrice) {
      const spread =
        ((livePrice.buyPrice - livePrice.sellPrice) / livePrice.sellPrice) *
        100;
      reasons.push(`Current dealer spread: ${spread.toFixed(1)}%`);
    }

    return {
      categoryId,
      signal,
      confidence: history.length >= 5 ? 'Medium' : 'Low',
      score,
      reasons,
      summary: `${category.nameEn} shows ${signal.toLowerCase()} conditions based on trend analysis`,
      risks: [
        'AI analysis unavailable — trend-based assessment only',
        'Egyptian gold market can be volatile',
      ],
      outlook: `Based on limited data, ${category.nameEn} is currently ${signal.toLowerCase()}`,
      horizon,
      buyVsSellSpread: livePrice
        ? +(
            ((livePrice.buyPrice - livePrice.sellPrice) / livePrice.sellPrice) *
            100
          ).toFixed(2)
        : null,
      globalCorrelation:
        'Unable to assess — AI analysis required for detailed correlation',
      source: 'trend-fallback',
    };
  }

  private buildFallbackResult(
    categoryId: string,
    horizon: Horizon,
  ): GoldSignalResult {
    return {
      categoryId,
      signal: 'Neutral',
      confidence: 'Low',
      score: 0,
      reasons: ['Category not found or insufficient data'],
      summary: `Unable to analyze ${categoryId}`,
      risks: ['No data available'],
      outlook: 'Insufficient data',
      horizon,
      buyVsSellSpread: null,
      globalCorrelation: 'N/A',
      source: 'trend-fallback',
    };
  }

  /** Get available gold analysis strategies */
  getStrategies() {
    return Object.entries(GOLD_STRATEGY_PROMPTS).map(([id, s]) => ({
      id,
      name: s.name,
      focus: s.focus,
    }));
  }
}
