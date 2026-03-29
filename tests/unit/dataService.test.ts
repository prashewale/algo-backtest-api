/**
 * Unit tests for data service — candle processing.
 * Uses the exact shape of your sample MongoDB document.
 * Run: npx ts-node tests/unit/dataService.test.ts
 */

import { processCandle, selectStrike, selectExpiry, getYearsForRange } from '../../src/services/dataService';
import { RawOptionChainDocument, ProcessedCandle } from '../../src/types';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}
function expect(v: any) {
  return {
    toBe: (e: any) => { if (v !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`); },
    toEqual: (e: any) => { if (JSON.stringify(v) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`); },
    toBeGreaterThan: (n: number) => { if (v <= n) throw new Error(`Expected > ${n}, got ${v}`); },
    toBeLessThan:    (n: number) => { if (v >= n) throw new Error(`Expected < ${n}, got ${v}`); },
    toBeNull:        () => { if (v !== null) throw new Error(`Expected null, got ${JSON.stringify(v)}`); },
    toBeWithin: (min: number, max: number) => {
      if (v < min || v > max) throw new Error(`Expected ${v} within [${min}, ${max}]`);
    },
  };
}

// ─── Sample document (matches your real collection shape) ─────────────────────

const sampleDoc: RawOptionChainDocument = {
  candle:     '2024-01-01T09:16:00',
  underlying: 'NIFTY',
  cash:       { timestamp: '2024-01-01T09:16:00', close: 21710.4 },
  futures: {
    '2024-01-25': { timestamp: '2024-01-01T09:16:00', close: 21835 },
    '2024-02-29': { timestamp: '2024-01-01T09:16:00', close: 21966.4 },
  },
  implied_futures: {
    '2024-01-04': 21726.6,
    '2024-01-25': 21833.75,
    '2024-03-28': 22147.88,
  },
  vix: { timestamp: '2024-01-01T09:16:00', close: 14.83 },
  perpetual_future: null,
  options: {
    '2024-01-04': {
      strike: [21500, 21600, 21700, 21750, 21800, 21900, 22000, 22100, 22200],
      call_close:        [null, 300, 200,  150,  110,   60,   30,   15,    8],
      call_open_interest:[null,   0,   0,    0,    0,    0,    0,    0,    0],
      call_implied_vol:  [null, 0.16, 0.15, 0.148, 0.145, 0.14, 0.142, 0.148, 0.16],
      call_delta:        [null, 0.75, 0.55, 0.45, 0.35, 0.20, 0.10, 0.06, 0.03],
      call_gamma:        [null, 0.0003, 0.0003, 0.0003, 0.0003, 0.0002, 0.0001, 0.00005, 0.00003],
      call_theta:        [null, -4.5, -4.0, -3.8, -3.5, -3.0, -2.5, -1.5, -0.8],
      call_vega:         [null, 38, 40, 41, 40, 35, 28, 18, 10],
      call_rho:          [null, 12, 10, 8, 6, 4, 2, 1, 0.5],
      call_timestamp:    [null, '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00'],
      put_close:         [380, 290, 190,  140,  100,   55,   28,   13,    6],
      put_open_interest: [0,     0,   0,    0,    0,    0,    0,    0,    0],
      put_implied_vol:   [0.18, 0.16, 0.15, 0.148, 0.145, 0.14, 0.142, 0.148, 0.16],
      put_delta:         [-0.25, -0.35, -0.45, -0.55, -0.65, -0.80, -0.90, -0.94, -0.97],
      put_gamma:         [0.0002, 0.0003, 0.0003, 0.0003, 0.0003, 0.0002, 0.0001, 0.00004, 0.00002],
      put_theta:         [-3.0, -3.5, -4.0, -3.8, -3.5, -3.0, -2.5, -1.5, -0.8],
      put_vega:          [30, 36, 40, 41, 40, 35, 28, 16, 8],
      put_rho:           [-8, -10, -12, -11, -10, -8, -5, -3, -1],
      put_timestamp:     ['2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00'],
    },
    '2024-03-28': {
      strike: [21000, 22000, 23000],
      call_close:        [null, 656.35, 231.65],
      call_open_interest:[null, 0, 0],
      call_implied_vol:  [null, 0.13458999, 0.1265516],
      call_delta:        [null, 0.5535783, 0.28123298],
      call_gamma:        [null, 0.00027, 0.00024],
      call_theta:        [null, -3.30, -2.64],
      call_vega:         [null, 42.81, 36.53],
      call_rho:          [null, 27.74, 14.33],
      call_timestamp:    [null, '2024-01-01T09:16:00', '2024-01-01T09:16:00'],
      put_close:         [12.15, 16, 49.95],
      put_open_interest: [0, 0, 0],
      put_implied_vol:   [0.2977, 0.2581, 0.1997],
      put_delta:         [-0.0105, -0.0154, -0.0527],
      put_gamma:         [0.000009, 0.000014, 0.00005],
      put_theta:         [-0.516, -0.621, -1.334],
      put_vega:          [3.02, 4.20, 11.66],
      put_rho:           [-0.587, -0.855, -2.913],
      put_timestamp:     ['2024-01-01T09:16:00', '2024-01-01T09:16:00', '2024-01-01T09:16:00'],
    },
  },
} as any;

// ─── processCandle tests ──────────────────────────────────────────────────────

console.log('\nprocessCandle');

let processed: ProcessedCandle;

test('returns spot price from cash.close', () => {
  processed = processCandle(sampleDoc);
  expect(processed.spotPrice).toBe(21710.4);
});

test('returns VIX from vix.close', () => {
  expect(processed.vix).toBe(14.83);
});

test('candle is a Date object', () => {
  expect(processed.candle instanceof Date).toBe(true);
});

test('expiries are sorted ascending', () => {
  const expiries = processed.expiries.map(e => e.expiry);
  const sorted = [...expiries].sort();
  expect(JSON.stringify(expiries)).toBe(JSON.stringify(sorted));
});

test('both expiries parsed (2024-01-04 and 2024-03-28)', () => {
  expect(processed.expiries.length).toBe(2);
});

test('nearest expiry is 2024-01-04', () => {
  expect(processed.expiries[0].expiry).toBe('2024-01-04');
});

test('ATM strike near spot (21710)', () => {
  const atm = processed.expiries[0].atmStrike;
  expect(Math.abs(atm - 21710.4)).toBeLessThan(100);
});

test('straddle premium = ATM call + put close', () => {
  const exp = processed.expiries[0];
  const atm = exp.strikes[exp.atmIndex];
  const expected = (atm.call?.close ?? 0) + (atm.put?.close ?? 0);
  expect(exp.straddlePremium).toBe(expected);
});

test('PCR is non-negative', () => {
  expect(processed.expiries[0].pcr).toBeGreaterThan(-0.001);
});

test('max pain strike is one of the strikes', () => {
  const exp = processed.expiries[0];
  const strikes = exp.strikes.map(s => s.strike);
  expect(strikes.includes(exp.maxPainStrike)).toBe(true);
});

test('strike moneyness is correct for ATM', () => {
  const exp = processed.expiries[0];
  const atm = exp.strikes[exp.atmIndex];
  expect(atm.moneyness).toBe('atm');
});

test('futures map populated', () => {
  expect(processed.futures['2024-01-25']).toBe(21835);
});

test('implied futures map populated', () => {
  expect(processed.impliedFutures['2024-01-04']).toBe(21726.6);
});

// ─── selectStrike tests ───────────────────────────────────────────────────────

console.log('\nselectStrike');

test('atm_offset(0) returns ATM strike', () => {
  const exp = processed.expiries[0];
  const strike = selectStrike(exp, { type: 'atm_offset', offset: 0 }, 'CE');
  expect(strike?.moneyness).toBe('atm');
});

test('atm_offset(1) returns next strike', () => {
  const exp = processed.expiries[0];
  const atm  = selectStrike(exp, { type: 'atm_offset', offset: 0 }, 'CE');
  const next = selectStrike(exp, { type: 'atm_offset', offset: 1 }, 'CE');
  expect(next?.strike).toBeGreaterThan(atm!.strike);
});

test('delta selection finds nearest 0.20 delta call', () => {
  const exp = processed.expiries[0];
  const strike = selectStrike(exp, { type: 'delta', targetDelta: 0.20 }, 'CE');
  // Delta 0.20 should map to a strike > ATM
  expect(strike?.call?.delta ?? 1).toBeLessThan(0.35);
});

test('fixed_strike returns null for non-existent strike', () => {
  const exp = processed.expiries[0];
  const strike = selectStrike(exp, { type: 'fixed_strike', strike: 99999 }, 'CE');
  expect(strike).toBeNull();
});

test('pct_otm(1) for CE returns a strike > ATM', () => {
  const exp = processed.expiries[0];
  const atm    = selectStrike(exp, { type: 'atm_offset', offset: 0 }, 'CE');
  const otm    = selectStrike(exp, { type: 'pct_otm', pct: 1 }, 'CE');
  expect(otm!.strike).toBeGreaterThan(atm!.strike - 1);
});

// ─── selectExpiry tests ───────────────────────────────────────────────────────

console.log('\nselectExpiry');

test('nearest returns first expiry', () => {
  const expiry = selectExpiry(processed.expiries, { type: 'nearest' }, processed.candle);
  expect(expiry?.expiry).toBe('2024-01-04');
});

test('weekly weekOffset=1 returns second expiry', () => {
  const expiry = selectExpiry(processed.expiries, { type: 'weekly', weekOffset: 1 }, processed.candle);
  expect(expiry?.expiry).toBe('2024-03-28');
});

test('fixed_expiry returns correct expiry', () => {
  const expiry = selectExpiry(processed.expiries, { type: 'fixed_expiry', date: '2024-03-28' }, processed.candle);
  expect(expiry?.expiry).toBe('2024-03-28');
});

// ─── getYearsForRange tests ───────────────────────────────────────────────────

console.log('\ngetYearsForRange');

test('single year range', () => {
  expect(getYearsForRange('2024-01-01', '2024-12-31')).toEqual([2024]);
});

test('multi-year range', () => {
  expect(getYearsForRange('2023-11-01', '2024-03-31')).toEqual([2023, 2024]);
});

test('3-year range', () => {
  expect(getYearsForRange('2022-01-01', '2024-12-31')).toEqual([2022, 2023, 2024]);
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
