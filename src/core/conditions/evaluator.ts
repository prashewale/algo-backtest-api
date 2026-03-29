import {
  ConditionTree, ConditionNode, ConditionGroup,
  ProcessedCandle, ConditionOperator,
} from '../../types';
import { selectExpiry, selectStrike } from '../../services/dataService';

// ─── Context passed to each condition evaluation ──────────────────────────────

export interface EvalContext {
  current: ProcessedCandle;
  previous?: ProcessedCandle;    // previous candle (for crossover detection)
  history?: ProcessedCandle[];   // recent history for lookback
}

// ─── Top-level evaluator ──────────────────────────────────────────────────────

export function evaluateConditionTree(
  tree: ConditionTree | undefined,
  ctx: EvalContext,
): boolean {
  if (!tree) return true;  // no condition = always true

  if (tree.type === 'condition') {
    return evaluateConditionNode(tree as ConditionNode, ctx);
  }
  return evaluateGroup(tree as ConditionGroup, ctx);
}

function evaluateGroup(group: ConditionGroup, ctx: EvalContext): boolean {
  const { logic, children } = group;

  if (logic === 'NOT') {
    const first = children[0];
    return first ? !evaluateConditionTree(first, ctx) : true;
  }
  if (logic === 'AND') {
    return children.every(c => evaluateConditionTree(c, ctx));
  }
  if (logic === 'OR') {
    return children.some(c => evaluateConditionTree(c, ctx));
  }
  return true;
}

// ─── Single condition evaluator ───────────────────────────────────────────────

function evaluateConditionNode(node: ConditionNode, ctx: EvalContext): boolean {
  try {
    const lhsValue = resolveField(node.field, ctx.current, node, ctx);
    if (lhsValue === null || lhsValue === undefined) return false;

    // Lookback: resolve lhs over a window and use last value
    const effectiveLhs = resolveLookback(node, ctx, lhsValue);

    const rhsValue = resolveRhs(node, ctx.current, lhsValue, ctx);
    if (rhsValue === null || rhsValue === undefined) return false;

    return applyOperator(effectiveLhs, node.operator, rhsValue, node, ctx);
  } catch {
    return false;
  }
}

function resolveLookback(node: ConditionNode, ctx: EvalContext, currentValue: number): number {
  if (!node.lookback || !ctx.history?.length) return currentValue;
  const n = node.lookback;
  const history = ctx.history.slice(-n);
  const values = history.map(h => resolveField(node.field, h, node, ctx)).filter((v): v is number => v != null);
  if (!values.length) return currentValue;
  // Return average over lookback window
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ─── Field resolver ───────────────────────────────────────────────────────────

/**
 * Resolves a field path like "cash.close", "call.delta", "vix.close",
 * "tech.rsi14", "time.days_to_expiry", etc. against a processed candle.
 */
export function resolveField(
  fieldId: string,
  candle: ProcessedCandle,
  node?: Pick<ConditionNode, 'strikeContext' | 'expiryContext'>,
  ctx?: EvalContext,
): number | null {
  const [category, ...rest] = fieldId.split('.');
  const key = rest.join('.');

  switch (category) {
    // ── Spot / Cash ──
    case 'cash':
      if (key === 'close') return candle.spotPrice;
      return null;

    // ── VIX ──
    case 'vix':
      if (key === 'close') return candle.vix;
      if (key === 'change_pct') return null; // needs prev candle, handled at caller
      return null;

    // ── Futures ──
    case 'futures': {
      const expiry = resolveExpiryDate(candle, node);
      if (!expiry) return null;
      if (key === 'close') return candle.futures[expiry] ?? null;
      return null;
    }

    case 'implied_futures': {
      const expiry = resolveExpiryDate(candle, node);
      if (!expiry) return null;
      return candle.impliedFutures[expiry] ?? null;
    }

    case 'fut_basis': {
      const expiry = resolveExpiryDate(candle, node);
      if (!expiry) return null;
      const fut = candle.futures[expiry];
      return fut != null ? fut - candle.spotPrice : null;
    }

    case 'fut_basis_pct': {
      const expiry = resolveExpiryDate(candle, node);
      if (!expiry) return null;
      const fut = candle.futures[expiry];
      return (fut != null && candle.spotPrice > 0) ? ((fut - candle.spotPrice) / candle.spotPrice) * 100 : null;
    }

    // ── Call / Put Greeks ──
    case 'call':
    case 'put': {
      const side = category as 'call' | 'put';
      const expiry = resolveExpiryObj(candle, node);
      if (!expiry) return null;
      const strike = resolveStrikeObj(expiry, side, node);
      if (!strike) return null;
      const greek = side === 'call' ? strike.call : strike.put;
      if (!greek) return null;
      return getGreekValue(greek, key);
    }

    // ── IV metrics ──
    case 'iv_skew': {
      const expiry = resolveExpiryObj(candle, node);
      return expiry?.ivSkew ?? null;
    }
    case 'iv_avg': {
      const expiry = resolveExpiryObj(candle, node);
      if (!expiry) return null;
      const atm = expiry.strikes[expiry.atmIndex];
      const cIV = atm?.call?.impliedVol ?? 0;
      const pIV = atm?.put?.impliedVol ?? 0;
      return (cIV + pIV) / 2;
    }
    case 'iv_percentile':
    case 'iv_rank':
      return null; // requires longer historical window; placeholder

    // ── PCR / OI ──
    case 'pcr_oi': {
      const expiry = resolveExpiryObj(candle, node);
      return expiry?.pcr ?? null;
    }
    case 'max_pain': {
      const expiry = resolveExpiryObj(candle, node);
      return expiry?.maxPainStrike ?? null;
    }
    case 'straddle_premium': {
      const expiry = resolveExpiryObj(candle, node);
      return expiry?.straddlePremium ?? null;
    }
    case 'synthetic_fut': {
      const expiry = resolveExpiryObj(candle, node);
      if (!expiry) return null;
      const atm = expiry.strikes[expiry.atmIndex];
      const c = atm?.call?.close ?? 0;
      const p = atm?.put?.close ?? 0;
      return expiry.atmStrike + c - p;
    }
    case 'call_put_spread': {
      const expiry = resolveExpiryObj(candle, node);
      if (!expiry) return null;
      const atm = expiry.strikes[expiry.atmIndex];
      const c = atm?.call?.close ?? 0;
      const p = atm?.put?.close ?? 0;
      return c - p;
    }

    // ── Candle OHLC (spot candle) ──
    case 'candle':
      // We only have close in the raw data; OHLC would need OHLCV series
      if (key === 'close') return candle.spotPrice;
      return null;

    // ── Time ──
    case 'time': {
      const dt = candle.candle;
      const h = dt.getHours(), m = dt.getMinutes();
      const minutesSinceOpen = (h - 9) * 60 + (m - 15);
      const minutesToClose   = (15 - h) * 60 + (30 - m);
      const dow = dt.getDay();    // 0=Sun, 1=Mon…5=Fri
      if (key === 'minutes_since_open') return minutesSinceOpen;
      if (key === 'minutes_to_close')   return minutesToClose;
      if (key === 'day_of_week')        return dow;
      if (key === 'days_to_expiry') {
        const expiry = resolveExpiryObj(candle, node);
        return expiry?.daysToExpiry ?? null;
      }
      return null;
    }

    // ── Technical indicators (computed from spot close history) ──
    case 'tech': {
      if (!ctx?.history?.length) return null;
      const closes = [...ctx.history.map((h: ProcessedCandle) => h.spotPrice), candle.spotPrice];
      const highs   = closes;
      const lows    = closes;
      const dates   = [...ctx.history.map((h: ProcessedCandle) => h.candle.toISOString()), candle.candle.toISOString()];
      const { computeTechSnapshot } = require('../../services/technicalIndicators');
      const snap = computeTechSnapshot(dates, closes, highs, lows);
      const keyMap: Record<string, keyof typeof snap> = {
        'ema9': 'ema9', 'ema21': 'ema21', 'ema50': 'ema50',
        'rsi14': 'rsi14', 'atr14': 'atr14',
        'bb_upper': 'bbUpper', 'bb_lower': 'bbLower', 'bb_width': 'bbWidth',
        'macd': 'macd', 'macd_signal': 'macdSignal',
        'supertrend': 'supertrend',
        'prev_day_high': 'prevDayHigh', 'prev_day_low': 'prevDayLow',
      };
      const snapKey = keyMap[key];
      return snapKey ? (snap[snapKey] as number | null) : null;
    }

    default:
      return null;
  }
}

function getGreekValue(greek: import('../../types').GreekSnapshot, key: string): number | null {
  switch (key) {
    case 'close':      return greek.close;
    case 'delta':      return greek.delta;
    case 'gamma':      return greek.gamma;
    case 'theta':      return greek.theta;
    case 'vega':       return greek.vega;
    case 'rho':        return greek.rho;
    case 'implied_vol': return greek.impliedVol;
    case 'implied_fut': return null; // resolved separately
    default: return null;
  }
}

// ─── Expiry / Strike context helpers ─────────────────────────────────────────

function resolveExpiryDate(
  candle: ProcessedCandle,
  node?: Pick<ConditionNode, 'expiryContext'>,
): string | null {
  const obj = resolveExpiryObj(candle, node);
  return obj?.expiry ?? null;
}

function resolveExpiryObj(
  candle: ProcessedCandle,
  node?: Pick<ConditionNode, 'expiryContext'>,
): import('../../types').ProcessedExpiry | null {
  if (!candle.expiries.length) return null;
  const ctx = node?.expiryContext ?? 'nearest';
  if (ctx === 'nearest') return candle.expiries[0] ?? null;
  if (ctx === 'weekly')  return candle.expiries[0] ?? null;
  if (ctx === 'monthly') {
    const m = candle.expiries.find(e => parseInt(e.expiry.split('-')[2]) >= 25);
    return m ?? candle.expiries[0] ?? null;
  }
  if (typeof ctx === 'object' && 'fixed' in ctx) {
    return candle.expiries.find(e => e.expiry === ctx.fixed) ?? null;
  }
  return candle.expiries[0] ?? null;
}

function resolveStrikeObj(
  expiry: import('../../types').ProcessedExpiry,
  side: 'call' | 'put',
  node?: Pick<ConditionNode, 'strikeContext'>,
): import('../../types').ProcessedStrike | null {
  const ctx = node?.strikeContext ?? 'atm';
  if (ctx === 'atm')    return expiry.strikes[expiry.atmIndex] ?? null;
  if (ctx === 'atm+1')  return expiry.strikes[expiry.atmIndex + 1] ?? null;
  if (ctx === 'atm-1')  return expiry.strikes[expiry.atmIndex - 1] ?? null;
  if (typeof ctx === 'object' && 'fixed' in ctx) {
    return expiry.strikes.find(s => s.strike === ctx.fixed) ?? null;
  }
  if (typeof ctx === 'object' && 'delta' in ctx) {
    const target = Math.abs(ctx.delta);
    let best: import('../../types').ProcessedStrike | null = null;
    let bestDiff = Infinity;
    for (const s of expiry.strikes) {
      const greek = side === 'call' ? s.call : s.put;
      if (!greek?.delta) continue;
      const diff = Math.abs(Math.abs(greek.delta) - target);
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return best;
  }
  return expiry.strikes[expiry.atmIndex] ?? null;
}

// ─── RHS resolver ─────────────────────────────────────────────────────────────

function resolveRhs(
  node: ConditionNode,
  candle: ProcessedCandle,
  lhsValue: number,
  ctx?: EvalContext,
): number | null {
  switch (node.rhsType) {
    case 'value':
      return node.rhsValue ?? null;
    case 'field':
      return node.rhsField ? resolveField(node.rhsField, candle, node, ctx) : null;
    case 'pct_of_field': {
      const fv = node.rhsField ? resolveField(node.rhsField, candle, node, ctx) : null;
      return (fv != null && node.rhsValue != null) ? fv * (node.rhsValue / 100) : null;
    }
    case 'field_plus': {
      const fv = node.rhsField ? resolveField(node.rhsField, candle, node, ctx) : null;
      return (fv != null && node.rhsValue != null) ? fv + node.rhsValue : null;
    }
    case 'field_minus': {
      const fv = node.rhsField ? resolveField(node.rhsField, candle, node, ctx) : null;
      return (fv != null && node.rhsValue != null) ? fv - node.rhsValue : null;
    }
    case 'field_mult': {
      const fv = node.rhsField ? resolveField(node.rhsField, candle, node, ctx) : null;
      return (fv != null && node.rhsValue != null) ? fv * node.rhsValue : null;
    }
    default:
      return null;
  }
}

// ─── Operator application ─────────────────────────────────────────────────────

function applyOperator(
  lhs: number,
  op: ConditionOperator,
  rhs: number,
  node: ConditionNode,
  ctx: EvalContext,
): boolean {
  switch (op) {
    case 'gt':  return lhs > rhs;
    case 'gte': return lhs >= rhs;
    case 'lt':  return lhs < rhs;
    case 'lte': return lhs <= rhs;
    case 'eq':  return Math.abs(lhs - rhs) < 0.0001;
    case 'neq': return Math.abs(lhs - rhs) >= 0.0001;
    case 'is_between':
      return (node.rhsFrom != null && node.rhsTo != null)
        ? lhs >= node.rhsFrom && lhs <= node.rhsTo
        : false;
    case 'pct_change_gt': {
      if (!ctx.previous) return false;
      const prev = resolveField(node.field, ctx.previous, node, ctx);
      if (!prev || prev === 0) return false;
      return ((lhs - prev) / Math.abs(prev)) * 100 > rhs;
    }
    case 'pct_change_lt': {
      if (!ctx.previous) return false;
      const prev = resolveField(node.field, ctx.previous, node, ctx);
      if (!prev || prev === 0) return false;
      return ((lhs - prev) / Math.abs(prev)) * 100 < rhs;
    }
    case 'crosses_above': {
      if (!ctx.previous) return false;
      const prevLhs = resolveField(node.field, ctx.previous, node, ctx);
      const prevRhs = resolveRhs(node, ctx.previous, prevLhs ?? 0, ctx);
      if (prevLhs == null || prevRhs == null) return false;
      return prevLhs <= prevRhs && lhs > rhs;
    }
    case 'crosses_below': {
      if (!ctx.previous) return false;
      const prevLhs = resolveField(node.field, ctx.previous, node, ctx);
      const prevRhs = resolveRhs(node, ctx.previous, prevLhs ?? 0, ctx);
      if (prevLhs == null || prevRhs == null) return false;
      return prevLhs >= prevRhs && lhs < rhs;
    }
    case 'before':
    case 'after': {
      // lhs = minutes_since_open, rhs = minutes threshold
      return op === 'before' ? lhs < rhs : lhs > rhs;
    }
    default:
      return false;
  }
}
