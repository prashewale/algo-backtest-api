import { v4 as uuidv4 } from 'uuid';
import { BacktestConfig, StrategyLeg, Instrument } from '../types';

// ─── Strategy template factory ────────────────────────────────────────────────

export type TemplateKey =
  | 'short_straddle'
  | 'short_strangle'
  | 'long_straddle'
  | 'iron_condor'
  | 'bull_call_spread'
  | 'bear_put_spread'
  | 'butterfly'
  | 'jade_lizard'
  | 'covered_call'
  | 'delta_neutral';

export interface StrategyTemplate {
  key: TemplateKey;
  name: string;
  description: string;
  legs: Omit<StrategyLeg, 'id'>[];
  defaultRiskRules: BacktestConfig['riskRules'];
  tags: string[];
}

export const STRATEGY_TEMPLATES: Record<TemplateKey, StrategyTemplate> = {

  short_straddle: {
    key: 'short_straddle',
    name: 'Short Straddle',
    description: 'Sell ATM call and put. Max profit at expiry if spot = strike. Unlimited risk.',
    legs: [
      { action: 'SELL', optionType: 'CE', strikeSelection: { type: 'atm_offset', offset: 0 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'SELL', optionType: 'PE', strikeSelection: { type: 'atm_offset', offset: 0 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 50, targetPct: 30, maxDailyLossPct: 3 },
    tags: ['neutral', 'premium-selling', 'high-risk'],
  },

  short_strangle: {
    key: 'short_strangle',
    name: 'Short Strangle',
    description: 'Sell OTM call and put. Wider profit range than straddle, lower premium.',
    legs: [
      { action: 'SELL', optionType: 'CE', strikeSelection: { type: 'delta', targetDelta: 0.20 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'SELL', optionType: 'PE', strikeSelection: { type: 'delta', targetDelta: -0.20 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 100, targetPct: 50, maxDailyLossPct: 3 },
    tags: ['neutral', 'premium-selling', 'defined-range'],
  },

  long_straddle: {
    key: 'long_straddle',
    name: 'Long Straddle',
    description: 'Buy ATM call and put. Profits from large moves in either direction.',
    legs: [
      { action: 'BUY', optionType: 'CE', strikeSelection: { type: 'atm_offset', offset: 0 }, expirySelection: { type: 'weekly', weekOffset: 1 }, lots: 1 },
      { action: 'BUY', optionType: 'PE', strikeSelection: { type: 'atm_offset', offset: 0 }, expirySelection: { type: 'weekly', weekOffset: 1 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 30, targetPct: 100, maxDailyLossPct: 2 },
    tags: ['directional', 'premium-buying', 'volatility'],
  },

  iron_condor: {
    key: 'iron_condor',
    name: 'Iron Condor',
    description: 'Short strangle + long wings for defined risk. Profit in range.',
    legs: [
      { action: 'SELL', optionType: 'CE', strikeSelection: { type: 'delta', targetDelta: 0.20  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'BUY',  optionType: 'CE', strikeSelection: { type: 'delta', targetDelta: 0.10  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'SELL', optionType: 'PE', strikeSelection: { type: 'delta', targetDelta: -0.20 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'BUY',  optionType: 'PE', strikeSelection: { type: 'delta', targetDelta: -0.10 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 100, targetPct: 50, maxDailyLossPct: 2 },
    tags: ['neutral', 'defined-risk', 'premium-selling'],
  },

  bull_call_spread: {
    key: 'bull_call_spread',
    name: 'Bull Call Spread',
    description: 'Buy ATM call, sell OTM call. Defined risk bullish play.',
    legs: [
      { action: 'BUY',  optionType: 'CE', strikeSelection: { type: 'atm_offset', offset: 0  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'SELL', optionType: 'CE', strikeSelection: { type: 'atm_offset', offset: 2  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 50, targetPct: 80, maxDailyLossPct: 2 },
    tags: ['bullish', 'defined-risk', 'spread'],
  },

  bear_put_spread: {
    key: 'bear_put_spread',
    name: 'Bear Put Spread',
    description: 'Buy ATM put, sell OTM put. Defined risk bearish play.',
    legs: [
      { action: 'BUY',  optionType: 'PE', strikeSelection: { type: 'atm_offset', offset: 0  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'SELL', optionType: 'PE', strikeSelection: { type: 'atm_offset', offset: -2 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 50, targetPct: 80, maxDailyLossPct: 2 },
    tags: ['bearish', 'defined-risk', 'spread'],
  },

  butterfly: {
    key: 'butterfly',
    name: 'Call Butterfly',
    description: 'Buy 1 ITM, sell 2 ATM, buy 1 OTM call. Max profit at ATM on expiry.',
    legs: [
      { action: 'BUY',  optionType: 'CE', strikeSelection: { type: 'atm_offset', offset: -2 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'SELL', optionType: 'CE', strikeSelection: { type: 'atm_offset', offset: 0  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 2 },
      { action: 'BUY',  optionType: 'CE', strikeSelection: { type: 'atm_offset', offset: 2  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 50, targetPct: 100, maxDailyLossPct: 1 },
    tags: ['neutral', 'defined-risk', 'low-cost'],
  },

  jade_lizard: {
    key: 'jade_lizard',
    name: 'Jade Lizard',
    description: 'Short OTM put + short OTM call spread. No upside risk.',
    legs: [
      { action: 'SELL', optionType: 'PE', strikeSelection: { type: 'delta', targetDelta: -0.30 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'SELL', optionType: 'CE', strikeSelection: { type: 'delta', targetDelta: 0.20  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'BUY',  optionType: 'CE', strikeSelection: { type: 'delta', targetDelta: 0.10  }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 100, targetPct: 50, maxDailyLossPct: 3 },
    tags: ['neutral-bullish', 'premium-selling', 'defined-upside-risk'],
  },

  covered_call: {
    key: 'covered_call',
    name: 'Covered Call (Options Only)',
    description: 'Short OTM call against a synthetic long. Yield enhancement.',
    legs: [
      { action: 'SELL', optionType: 'CE', strikeSelection: { type: 'delta', targetDelta: 0.30 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 200, targetPct: 80, maxDailyLossPct: 2 },
    tags: ['bullish', 'premium-selling', 'yield'],
  },

  delta_neutral: {
    key: 'delta_neutral',
    name: 'Delta Neutral Straddle',
    description: 'Short straddle with delta-neutral adjustment. Uses 0.5 delta targeting.',
    legs: [
      { action: 'SELL', optionType: 'CE', strikeSelection: { type: 'delta', targetDelta: 0.50 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
      { action: 'SELL', optionType: 'PE', strikeSelection: { type: 'delta', targetDelta: -0.50 }, expirySelection: { type: 'weekly', weekOffset: 0 }, lots: 1 },
    ],
    defaultRiskRules: { stopLossPct: 40, targetPct: 25, maxDailyLossPct: 3 },
    tags: ['neutral', 'delta-neutral', 'premium-selling'],
  },
};

// ─── Build a full BacktestConfig from a template ──────────────────────────────

export function buildConfigFromTemplate(
  key: TemplateKey,
  overrides: Partial<BacktestConfig> & {
    instrument: Instrument;
    startDate: string;
    endDate: string;
    capital: number;
    lotSize: number;
  },
): BacktestConfig {
  const template = STRATEGY_TEMPLATES[key];
  if (!template) throw new Error(`Unknown template: ${key}`);

  return {
    name:       overrides.name ?? template.name,
    instrument: overrides.instrument,
    startDate:  overrides.startDate,
    endDate:    overrides.endDate,
    entryTime:  overrides.entryTime ?? '09:30',
    exitTime:   overrides.exitTime  ?? '15:15',
    capital:    overrides.capital,
    lotSize:    overrides.lotSize,
    legs:       template.legs.map(l => ({ ...l, id: uuidv4() })),
    conditions: overrides.conditions ?? {},
    riskRules:  overrides.riskRules ?? template.defaultRiskRules,
  };
}

export function listTemplates(): (StrategyTemplate & { legsCount: number })[] {
  return Object.values(STRATEGY_TEMPLATES).map(t => ({
    ...t,
    legsCount: t.legs.length,
  }));
}
