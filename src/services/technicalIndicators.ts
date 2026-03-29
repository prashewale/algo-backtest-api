/**
 * Technical Indicators computed over ProcessedCandle history.
 * These power the "tech.*" field namespace in the condition evaluator.
 *
 * All indicators return null when insufficient history is available.
 */

export interface TechSnapshot {
  ema9:         number | null;
  ema21:        number | null;
  ema50:        number | null;
  rsi14:        number | null;
  atr14:        number | null;
  bbUpper:      number | null;
  bbMiddle:     number | null;
  bbLower:      number | null;
  bbWidth:      number | null;
  macd:         number | null;
  macdSignal:   number | null;
  macdHist:     number | null;
  supertrend:   number | null;   // 1 = bullish, -1 = bearish
  prevDayHigh:  number | null;
  prevDayLow:   number | null;
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

export function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
  }
  return e;
}

export function emaArray(closes: number[], period: number): (number | null)[] {
  if (closes.length < period) return closes.map(() => null);
  const k = 2 / (period + 1);
  const result: (number | null)[] = Array(period - 1).fill(null);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(e);
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    result.push(e);
  }
  return result;
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

export function rsi(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const recent = changes.slice(-period);
  const gains  = recent.map(c => c > 0 ? c : 0);
  const losses = recent.map(c => c < 0 ? Math.abs(c) : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ─── ATR ──────────────────────────────────────────────────────────────────────

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14,
): number | null {
  if (closes.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

export function bollingerBands(
  closes: number[],
  period: number = 20,
  multiplier: number = 2,
): { upper: number; middle: number; lower: number; width: number } | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const mean   = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    upper:  mean + multiplier * sd,
    middle: mean,
    lower:  mean - multiplier * sd,
    width:  (mean + multiplier * sd) - (mean - multiplier * sd),
  };
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

export function macd(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const fastEMA = emaArray(closes, fastPeriod);
  const slowEMA = emaArray(closes, slowPeriod);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = fastEMA[i], s = slowEMA[i];
    if (f != null && s != null) macdLine.push(f - s);
  }

  if (macdLine.length < signalPeriod) return null;

  const signalLine = ema(macdLine, signalPeriod);
  if (signalLine === null) return null;

  const lastMacd = macdLine[macdLine.length - 1];
  return {
    macd:      lastMacd,
    signal:    signalLine,
    histogram: lastMacd - signalLine,
  };
}

// ─── Supertrend ───────────────────────────────────────────────────────────────

export function supertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 10,
  multiplier: number = 3,
): 1 | -1 | null {
  const len = closes.length;
  if (len < period + 1) return null;

  // Compute ATR for each bar
  const trs: number[] = [0];
  for (let i = 1; i < len; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }

  // Wilder's smoothed ATR
  const atrs: number[] = new Array(period).fill(0);
  let sumTR = trs.slice(1, period + 1).reduce((a, b) => a + b, 0);
  atrs.push(sumTR / period);
  for (let i = period + 1; i < len; i++) {
    atrs.push((atrs[atrs.length - 1] * (period - 1) + trs[i]) / period);
  }

  // Basic bands
  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  const direction: (1 | -1)[] = [];

  for (let i = 0; i < len; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    upperBand.push(hl2 + multiplier * (atrs[i] ?? 0));
    lowerBand.push(hl2 - multiplier * (atrs[i] ?? 0));
  }

  // Apply continuity rules
  const finalUpper = [...upperBand];
  const finalLower = [...lowerBand];

  for (let i = 1; i < len; i++) {
    finalUpper[i] = (finalUpper[i] < finalUpper[i - 1] || closes[i - 1] > finalUpper[i - 1])
      ? finalUpper[i] : finalUpper[i - 1];
    finalLower[i] = (finalLower[i] > finalLower[i - 1] || closes[i - 1] < finalLower[i - 1])
      ? finalLower[i] : finalLower[i - 1];
  }

  // Determine direction
  let dir: 1 | -1 = 1;
  for (let i = 1; i < len; i++) {
    const prevDir = dir;
    if (prevDir === -1 && closes[i] > finalUpper[i - 1]) dir = 1;
    else if (prevDir === 1 && closes[i] < finalLower[i - 1]) dir = -1;
    direction.push(dir);
  }

  return direction[direction.length - 1] ?? null;
}

// ─── Prev day high/low ────────────────────────────────────────────────────────

export function prevDayHighLow(
  candleDates: string[],  // ISO strings
  closes: number[],
  highs?: number[],
  lows?: number[],
): { high: number; low: number } | null {
  if (candleDates.length < 2) return null;
  const today = candleDates[candleDates.length - 1].slice(0, 10);
  // Find the last candle from a different day
  let lastPrevIdx = -1;
  for (let i = candleDates.length - 1; i >= 0; i--) {
    if (candleDates[i].slice(0, 10) !== today) { lastPrevIdx = i; break; }
  }
  if (lastPrevIdx < 0) return null;
  const prevDay = candleDates[lastPrevIdx].slice(0, 10);
  const prevIndices = candleDates.reduce<number[]>((acc, d, i) => {
    if (d.slice(0, 10) === prevDay) acc.push(i);
    return acc;
  }, []);
  if (!prevIndices.length) return null;
  const h = highs  ? Math.max(...prevIndices.map(i => highs[i]))  : Math.max(...prevIndices.map(i => closes[i]));
  const l = lows   ? Math.min(...prevIndices.map(i => lows[i]))   : Math.min(...prevIndices.map(i => closes[i]));
  return { high: h, low: l };
}

// ─── Compute full snapshot from candle history ────────────────────────────────

export function computeTechSnapshot(
  dates:  string[],
  closes: number[],
  highs:  number[],
  lows:   number[],
): TechSnapshot {
  const bb   = bollingerBands(closes);
  const macdResult = macd(closes);
  const pdhl = prevDayHighLow(dates, closes, highs, lows);

  return {
    ema9:        ema(closes, 9),
    ema21:       ema(closes, 21),
    ema50:       ema(closes, 50),
    rsi14:       rsi(closes, 14),
    atr14:       atr(highs, lows, closes, 14),
    bbUpper:     bb?.upper  ?? null,
    bbMiddle:    bb?.middle ?? null,
    bbLower:     bb?.lower  ?? null,
    bbWidth:     bb?.width  ?? null,
    macd:        macdResult?.macd      ?? null,
    macdSignal:  macdResult?.signal    ?? null,
    macdHist:    macdResult?.histogram ?? null,
    supertrend:  supertrend(highs, lows, closes),
    prevDayHigh: pdhl?.high ?? null,
    prevDayLow:  pdhl?.low  ?? null,
  };
}
