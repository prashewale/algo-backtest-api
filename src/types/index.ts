import { ObjectId } from 'mongoose';

// ─── Raw MongoDB document (as stored) ────────────────────────────────────────

export interface RawOptionChainDocument {
  _id?: ObjectId;
  candle: string;           // ISO datetime "2024-01-01T09:16:00"
  underlying: string;       // "NIFTY" | "BANKNIFTY" | etc.
  cash: {
    timestamp: string;
    close: number;
  };
  futures: Record<string, {   // key = expiry date "2024-01-25"
    timestamp: string;
    close: number;
  }>;
  implied_futures: Record<string, number>;  // key = expiry date, value = price
  options: Record<string, RawOptionExpiry>; // key = expiry date
  vix: {
    timestamp: string;
    close: number;
  };
  perpetual_future: null | number;
}

export interface RawOptionExpiry {
  strike: number[];
  // Call side
  call_close: (number | null)[];
  call_open_interest: (number | null)[];
  call_implied_vol: (number | null)[];
  call_delta: (number | null)[];
  call_gamma: (number | null)[];
  call_theta: (number | null)[];
  call_vega: (number | null)[];
  call_rho: (number | null)[];
  call_timestamp: (string | null)[];
  // Put side
  put_close: (number | null)[];
  put_open_interest: (number | null)[];
  put_implied_vol: (number | null)[];
  put_delta: (number | null)[];
  put_gamma: (number | null)[];
  put_theta: (number | null)[];
  put_vega: (number | null)[];
  put_rho: (number | null)[];
  put_timestamp: (string | null)[];
}

// ─── Enriched / computed candle (after processing) ───────────────────────────

export interface ProcessedCandle {
  candle: Date;
  underlying: string;
  spotPrice: number;
  vix: number;
  expiries: ProcessedExpiry[];
  futures: Record<string, number>;
  impliedFutures: Record<string, number>;
}

export interface ProcessedExpiry {
  expiry: string;            // "2024-01-04"
  daysToExpiry: number;
  impliedFuture: number;
  strikes: ProcessedStrike[];
  // Computed chain-level metrics
  atmStrike: number;
  atmIndex: number;
  straddlePremium: number;
  pcr: number;               // put/call OI ratio
  maxPainStrike: number;
  ivSkew: number;            // ATM call IV - ATM put IV
}

export interface ProcessedStrike {
  strike: number;
  moneyness: 'deep_itm' | 'itm' | 'atm' | 'otm' | 'deep_otm';
  strikePctFromAtm: number;   // (strike - atm) / atm * 100
  call: GreekSnapshot | null;
  put: GreekSnapshot | null;
}

export interface GreekSnapshot {
  close: number;
  openInterest: number | null;
  impliedVol: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  timestamp: string | null;
}

// ─── Instrument / Collection mapping ─────────────────────────────────────────

export type Instrument = 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY' | 'MIDCPNIFTY' | 'BANKEX' | 'SENSEX';

export const INSTRUMENTS: Instrument[] = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX', 'SENSEX'];

export function getCollectionName(instrument: Instrument, year: number): string {
  return `option_chain_${instrument.toLowerCase()}_${year}`;
}

export function parseCollectionName(name: string): { instrument: Instrument; year: number } | null {
  const match = name.match(/^option_chain_([a-z]+)_(\d{4})$/);
  if (!match) return null;
  const instrument = match[1].toUpperCase() as Instrument;
  const year = parseInt(match[2]);
  if (!INSTRUMENTS.includes(instrument)) return null;
  return { instrument, year };
}

// ─── Strategy types ───────────────────────────────────────────────────────────

export type OptionType = 'CE' | 'PE';
export type TradeAction = 'BUY' | 'SELL';

export interface StrategyLeg {
  id: string;
  action: TradeAction;
  optionType: OptionType;
  strikeSelection: StrikeSelection;
  expirySelection: ExpirySelection;
  lots: number;
}

export type StrikeSelection =
  | { type: 'atm_offset'; offset: number }          // 0 = ATM, 1 = ATM+1 step, -1 = ATM-1 step
  | { type: 'delta'; targetDelta: number }            // pick strike closest to this delta
  | { type: 'fixed_strike'; strike: number }
  | { type: 'pct_otm'; pct: number };               // e.g. 2 = 2% OTM

export type ExpirySelection =
  | { type: 'nearest' }
  | { type: 'weekly'; weekOffset: number }           // 0 = current week, 1 = next week
  | { type: 'monthly'; monthOffset: number }
  | { type: 'fixed_expiry'; date: string };

// ─── Condition tree (from condition builder) ─────────────────────────────────

export type ConditionLogic = 'AND' | 'OR' | 'NOT';
export type ConditionOperator =
  | 'crosses_above' | 'crosses_below'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  | 'pct_change_gt' | 'pct_change_lt'
  | 'is_between'
  | 'before' | 'after';

export type RhsType = 'value' | 'field' | 'pct_of_field' | 'field_plus' | 'field_minus' | 'field_mult';

export interface ConditionNode {
  id: string;
  type: 'condition';
  field: string;              // e.g. "cash.close", "call.delta", "vix.close"
  operator: ConditionOperator;
  rhsType: RhsType;
  rhsValue?: number;
  rhsField?: string;
  rhsFrom?: number;           // for is_between
  rhsTo?: number;
  lookback?: number;
  lookbackUnit?: 'candles' | 'minutes' | 'days';
  // Strike / expiry context for option fields
  strikeContext?: 'atm' | 'atm+1' | 'atm-1' | { fixed: number } | { delta: number };
  expiryContext?: 'nearest' | 'weekly' | 'monthly' | { fixed: string };
}

export interface ConditionGroup {
  id: string;
  type: 'group';
  logic: ConditionLogic;
  children: ConditionTree[];
}

export type ConditionTree = ConditionNode | ConditionGroup;

export interface StrategyConditions {
  entry?: ConditionTree;
  exit?: ConditionTree;
  stopLoss?: ConditionTree;
  target?: ConditionTree;
  trailingStop?: ConditionTree;
  reEntry?: ConditionTree;
  positionSize?: ConditionTree;
  hedge?: ConditionTree;
  alert?: ConditionTree;
}

// ─── Backtest configuration ───────────────────────────────────────────────────

export interface BacktestConfig {
  id?: string;
  name: string;
  instrument: Instrument;
  startDate: string;    // "2024-01-01"
  endDate: string;      // "2024-12-31"
  entryTime: string;    // "09:30"
  exitTime: string;     // "15:15"
  capital: number;
  lotSize: number;
  legs: StrategyLeg[];
  conditions: StrategyConditions;
  riskRules: RiskRules;
}

export interface RiskRules {
  stopLossPct?: number;       // % of premium / position
  targetPct?: number;
  maxDailyLossPct?: number;   // % of capital
  trailingStop?: {
    enabled: boolean;
    trailPct: number;
  };
  reEntry?: {
    enabled: boolean;
    maxCount: number;
  };
  ivFilter?: {
    enabled: boolean;
    minIV: number;
    maxIV: number;
  };
  vixFilter?: {
    enabled: boolean;
    maxVix: number;
  };
}

// ─── Backtest results ─────────────────────────────────────────────────────────

export interface BacktestJob {
  _id?: ObjectId;
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  config: BacktestConfig;
  progress: number;            // 0–100
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  result?: BacktestResult;
}

export interface BacktestResult {
  summary: BacktestSummary;
  equityCurve: EquityPoint[];
  trades: TradeRecord[];
  monthlyPnl: MonthlyPnl[];
  greeksTimeline: GreeksTimelinePoint[];
  conditionStats: ConditionStats;
}

export interface BacktestSummary {
  totalReturn: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;  // days
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  wins: number;
  losses: number;
  avgWin: number;
  avgLoss: number;
  netPnl: number;
  finalEquity: number;
  avgMarginUsed: number;
  maxConsecutiveLosses: number;
  maxConsecutiveWins: number;
}

export interface EquityPoint {
  date: string;
  value: number;
  drawdown: number;
}

export interface TradeRecord {
  id: number;
  entryCandle: string;
  exitCandle: string;
  legs: TradeRecordLeg[];
  entryTime: string;
  exitTime: string;
  pnl: number;
  status: 'WIN' | 'LOSS' | 'BREAKEVEN';
  exitReason: 'stop_loss' | 'target' | 'time_exit' | 'condition_exit' | 'eod';
  marginUsed: number;
  netGreeks: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
  entryConditionSnapshot?: Record<string, number>;
}

export interface TradeRecordLeg {
  legId: string;
  action: TradeAction;
  optionType: OptionType;
  expiry: string;
  strike: number;
  entryPrice: number;
  exitPrice: number;
  lots: number;
  pnl: number;
  greeksAtEntry: Partial<GreekSnapshot>;
}

export interface MonthlyPnl {
  month: string;   // "2024-01"
  pnl: number;
  trades: number;
  winRate: number;
}

export interface GreeksTimelinePoint {
  date: string;
  iv: number;
  delta: number;
  theta: number;
  vega: number;
  vix: number;
  spotPrice: number;
}

export interface ConditionStats {
  entryConditionFired: number;
  entryConditionSkipped: number;
  exitConditionFired: number;
  slConditionFired: number;
  targetConditionFired: number;
  alertsFired: number;
}

// ─── Simulator types ──────────────────────────────────────────────────────────

export interface SimulatorSession {
  sessionId: string;
  instrument: Instrument;
  currentCandle: string;
  speed: number;             // multiplier: 1x, 5x, 60x (per-minute = realtime, etc.)
  isPlaying: boolean;
  positions: SimulatorPosition[];
  cashBalance: number;
  totalPnl: number;
  trade_log: SimulatorTrade[];
}

export interface SimulatorPosition {
  id: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
  action: TradeAction;
  lots: number;
  lotSize: number;
  entryPrice: number;
  entryCandle: string;
  currentPrice?: number;
  unrealizedPnl?: number;
  greeks?: Partial<GreekSnapshot>;
}

export interface SimulatorTrade {
  id: string;
  type: 'open' | 'close';
  positionId: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
  action: TradeAction;
  lots: number;
  price: number;
  candle: string;
  pnl?: number;
}

// ─── API request/response shapes ─────────────────────────────────────────────

export interface CreateBacktestRequest {
  config: BacktestConfig;
  priority?: 'low' | 'normal' | 'high';
}

export interface BacktestJobResponse {
  jobId: string;
  status: string;
  message: string;
  pollUrl: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
