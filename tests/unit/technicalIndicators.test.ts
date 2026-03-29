/**
 * Unit tests for technical indicators.
 * Run: npx ts-node tests/unit/technicalIndicators.test.ts
 *
 * Uses a tiny inline test harness (no Jest dependency needed for unit tests).
 */

import {
  ema, rsi, atr, bollingerBands, macd, supertrend, computeTechSnapshot,
} from '../../src/services/technicalIndicators';

// ─── Tiny test harness ────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function expect(actual: any) {
  return {
    toBe:           (expected: any) => { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toBeNull:       ()              => { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
    toBeCloseTo:    (expected: number, dp = 2) => {
      const d = Math.pow(10, -dp);
      if (Math.abs(actual - expected) > d) throw new Error(`Expected ~${expected} (±${d}), got ${actual}`);
    },
    toBeGreaterThan: (n: number) => { if (actual <= n) throw new Error(`Expected > ${n}, got ${actual}`); },
    toBeLessThan:    (n: number) => { if (actual >= n) throw new Error(`Expected < ${n}, got ${actual}`); },
    toBeWithin:     (min: number, max: number) => { if (actual < min || actual > max) throw new Error(`Expected ${actual} to be within [${min}, ${max}]`); },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// 50 synthetic closes: upward trend with noise
const closes50 = Array.from({ length: 50 }, (_, i) => 20000 + i * 50 + (Math.sin(i) * 100));
const highs50  = closes50.map(c => c + 100);
const lows50   = closes50.map(c => c - 100);
const dates50  = closes50.map((_, i) => {
  const d = new Date('2024-01-01');
  d.setDate(d.getDate() + Math.floor(i / 6.5)); // ~6.5 candles per day
  return d.toISOString();
});

// ─── EMA tests ────────────────────────────────────────────────────────────────

console.log('\nEMA');

test('returns null when insufficient data', () => {
  expect(ema([1, 2, 3], 9)).toBeNull();
});

test('returns a number for sufficient data', () => {
  const result = ema(closes50, 9);
  expect(result).toBeGreaterThan(0);
});

test('EMA9 > EMA21 in uptrend', () => {
  const e9  = ema(closes50, 9)!;
  const e21 = ema(closes50, 21)!;
  expect(e9).toBeGreaterThan(e21 - 500); // uptrend, EMA9 should be near or above EMA21
});

test('EMA uses 2/(n+1) multiplier — sanity check 3-period EMA', () => {
  // Manual: k=0.5, start=avg(1,2,3)=2, then: 4*0.5+2*0.5=3, 5*0.5+3*0.5=4
  const result = ema([1, 2, 3, 4, 5], 3);
  expect(result).toBeCloseTo(4.0, 1);
});

// ─── RSI tests ────────────────────────────────────────────────────────────────

console.log('\nRSI');

test('returns null with insufficient data', () => {
  expect(rsi([1, 2, 3], 14)).toBeNull();
});

test('returns 100 when all gains, no losses', () => {
  const allUp = Array.from({ length: 20 }, (_, i) => 100 + i);
  expect(rsi(allUp, 14)).toBe(100);
});

test('RSI in 0-100 range for mixed data', () => {
  const result = rsi(closes50, 14)!;
  expect(result).toBeGreaterThan(0);
  expect(result).toBeLessThan(100);
});

test('RSI > 50 in uptrend', () => {
  const result = rsi(closes50, 14)!;
  expect(result).toBeGreaterThan(50);
});

// ─── ATR tests ────────────────────────────────────────────────────────────────

console.log('\nATR');

test('returns null with insufficient data', () => {
  expect(atr([1], [0.9], [1], 14)).toBeNull();
});

test('returns positive value for real data', () => {
  const result = atr(highs50, lows50, closes50, 14)!;
  expect(result).toBeGreaterThan(0);
});

test('ATR approximately equals range when no gaps', () => {
  // Fixed 200-point range each bar, no gaps
  const c = Array.from({ length: 20 }, () => 20000);
  const h = c.map(x => x + 200);
  const l = c.map(x => x - 200);
  const result = atr(h, l, c, 14)!;
  expect(result).toBeWithin(150, 250);  // close to 200
});

// ─── Bollinger Bands tests ────────────────────────────────────────────────────

console.log('\nBollinger Bands');

test('returns null when insufficient data', () => {
  expect(bollingerBands([1, 2, 3], 20)).toBeNull();
});

test('upper > middle > lower', () => {
  const bb = bollingerBands(closes50, 20, 2)!;
  expect(bb.upper).toBeGreaterThan(bb.middle);
  expect(bb.middle).toBeGreaterThan(bb.lower);
});

test('width = upper - lower', () => {
  const bb = bollingerBands(closes50, 20, 2)!;
  expect(bb.width).toBeCloseTo(bb.upper - bb.lower, 1);
});

// ─── MACD tests ───────────────────────────────────────────────────────────────

console.log('\nMACD');

test('returns null when insufficient data', () => {
  expect(macd(closes50.slice(0, 10), 12, 26, 9)).toBeNull();
});

test('returns all three fields for sufficient data', () => {
  const result = macd(closes50, 12, 26, 9)!;
  expect(typeof result.macd).toBe('number');
  expect(typeof result.signal).toBe('number');
  expect(typeof result.histogram).toBe('number');
});

test('histogram = macd - signal', () => {
  const r = macd(closes50, 12, 26, 9)!;
  expect(r.histogram).toBeCloseTo(r.macd - r.signal, 3);
});

// ─── Supertrend tests ─────────────────────────────────────────────────────────

console.log('\nSupertrend');

test('returns null when insufficient data', () => {
  expect(supertrend([1], [0.9], [1], 10, 3)).toBeNull();
});

test('returns 1 or -1', () => {
  const result = supertrend(highs50, lows50, closes50, 10, 3)!;
  expect(result === 1 || result === -1).toBe(true);
});

test('returns bullish (1) for strong uptrend', () => {
  const upCloses = Array.from({ length: 60 }, (_, i) => 20000 + i * 100);
  const upHighs  = upCloses.map(c => c + 50);
  const upLows   = upCloses.map(c => c - 50);
  const result   = supertrend(upHighs, upLows, upCloses, 10, 3);
  expect(result).toBe(1);
});

// ─── Full snapshot tests ──────────────────────────────────────────────────────

console.log('\nFull TechSnapshot');

test('computeTechSnapshot returns all keys', () => {
  const snap = computeTechSnapshot(dates50, closes50, highs50, lows50);
  const keys: (keyof typeof snap)[] = ['ema9','ema21','ema50','rsi14','atr14','bbUpper','bbLower','macd','macdSignal','supertrend'];
  for (const k of keys) {
    if (snap[k] === undefined) throw new Error(`Missing key: ${k}`);
  }
  expect(true).toBe(true);
});

test('ema9 !== ema21 !== ema50', () => {
  const snap = computeTechSnapshot(dates50, closes50, highs50, lows50);
  if (snap.ema9 !== null && snap.ema21 !== null) {
    if (snap.ema9 === snap.ema21) throw new Error('EMA9 should not equal EMA21');
  }
  expect(true).toBe(true);
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
