/**
 * Unit tests for the margin calculator.
 * Run: npx ts-node tests/unit/marginCalculator.test.ts
 */

import { calculateMargin, tradeLegsToMarginPositions } from '../../src/services/marginCalculator';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}
function expect(v: any) {
  return {
    toBeGreaterThan: (n: number) => { if (v <= n) throw new Error(`Expected > ${n}, got ${v}`); },
    toBeLessThan:    (n: number) => { if (v >= n) throw new Error(`Expected < ${n}, got ${v}`); },
    toBe:  (e: any) => { if (v !== e) throw new Error(`Expected ${e}, got ${v}`); },
    toBeWithin: (min: number, max: number) => {
      if (v < min || v > max) throw new Error(`Expected ${v} within [${min}, ${max}]`);
    },
  };
}

const NIFTY_SPOT = 21726;
const INDEX_PRICES = { NIFTY: NIFTY_SPOT } as any;

// ─── Short straddle ───────────────────────────────────────────────────────────

console.log('\nShort Straddle');

test('short straddle requires positive margin', () => {
  const result = calculateMargin([
    { Ticker: 'NIFTY', Strike: 21700, InstrumentType: 'CE', NetQty: -1, Expiry: '2024-01-04', Premium: 200 },
    { Ticker: 'NIFTY', Strike: 21700, InstrumentType: 'PE', NetQty: -1, Expiry: '2024-01-04', Premium: 195 },
  ], INDEX_PRICES);

  expect(result.FinalSpan).toBeGreaterThan(0);
  expect(result.FinalExposure).toBeGreaterThan(0);
  expect(result.TotalMargin).toBeGreaterThan(result.FinalSpan);
});

test('long options have lower margin than short', () => {
  const shortResult = calculateMargin([
    { Ticker: 'NIFTY', Strike: 21700, InstrumentType: 'CE', NetQty: -1, Expiry: '2024-01-04', Premium: 200 },
  ], INDEX_PRICES);

  const longResult = calculateMargin([
    { Ticker: 'NIFTY', Strike: 21700, InstrumentType: 'CE', NetQty: 1, Expiry: '2024-01-04', Premium: 200 },
  ], INDEX_PRICES);

  expect(shortResult.TotalMargin).toBeGreaterThan(longResult.TotalMargin);
});

// ─── Iron condor hedge benefit ────────────────────────────────────────────────

console.log('\nIron Condor Hedge Benefit');

test('iron condor has positive hedge benefit', () => {
  const result = calculateMargin([
    { Ticker: 'NIFTY', Strike: 22000, InstrumentType: 'CE', NetQty: -1, Expiry: '2024-01-04', Premium: 50 },
    { Ticker: 'NIFTY', Strike: 22200, InstrumentType: 'CE', NetQty:  1, Expiry: '2024-01-04', Premium: 20 },
    { Ticker: 'NIFTY', Strike: 21400, InstrumentType: 'PE', NetQty: -1, Expiry: '2024-01-04', Premium: 55 },
    { Ticker: 'NIFTY', Strike: 21200, InstrumentType: 'PE', NetQty:  1, Expiry: '2024-01-04', Premium: 18 },
  ], INDEX_PRICES);

  expect(result.MarginBenefit).toBeGreaterThan(0);
});

test('iron condor total margin < naked short straddle', () => {
  const condor = calculateMargin([
    { Ticker: 'NIFTY', Strike: 22000, InstrumentType: 'CE', NetQty: -1, Expiry: '2024-01-04', Premium: 50 },
    { Ticker: 'NIFTY', Strike: 22200, InstrumentType: 'CE', NetQty:  1, Expiry: '2024-01-04', Premium: 20 },
    { Ticker: 'NIFTY', Strike: 21400, InstrumentType: 'PE', NetQty: -1, Expiry: '2024-01-04', Premium: 55 },
    { Ticker: 'NIFTY', Strike: 21200, InstrumentType: 'PE', NetQty:  1, Expiry: '2024-01-04', Premium: 18 },
  ], INDEX_PRICES);

  const naked = calculateMargin([
    { Ticker: 'NIFTY', Strike: 22000, InstrumentType: 'CE', NetQty: -1, Expiry: '2024-01-04', Premium: 50 },
    { Ticker: 'NIFTY', Strike: 21400, InstrumentType: 'PE', NetQty: -1, Expiry: '2024-01-04', Premium: 55 },
  ], INDEX_PRICES);

  expect(condor.TotalMargin).toBeLessThan(naked.TotalMargin);
});

// ─── Expiry day ───────────────────────────────────────────────────────────────

console.log('\nExpiry Day');

test('expiry day margin higher than normal day', () => {
  const position = [
    { Ticker: 'NIFTY' as const, Strike: 21700, InstrumentType: 'CE' as const, NetQty: -1, Expiry: '2024-01-04', Premium: 200 },
  ];

  const normal  = calculateMargin(position, INDEX_PRICES, false);
  const expDay  = calculateMargin(position, INDEX_PRICES, true);

  expect(expDay.FinalSpan).toBeGreaterThan(normal.FinalSpan);
});

// ─── tradeLegsToMarginPositions ───────────────────────────────────────────────

console.log('\ntradeLegsToMarginPositions');

test('BUY becomes NetQty +1', () => {
  const positions = tradeLegsToMarginPositions([{
    strike: 21700, optionType: 'CE', action: 'BUY',
    lots: 1, lotSize: 50, expiry: '2024-01-04', entryPrice: 200,
  }], 'NIFTY');

  expect(positions[0].NetQty).toBe(1);
});

test('SELL becomes NetQty -1', () => {
  const positions = tradeLegsToMarginPositions([{
    strike: 21700, optionType: 'CE', action: 'SELL',
    lots: 1, lotSize: 50, expiry: '2024-01-04', entryPrice: 200,
  }], 'NIFTY');

  expect(positions[0].NetQty).toBe(-1);
});

test('lots multiply NetQty', () => {
  const positions = tradeLegsToMarginPositions([{
    strike: 21700, optionType: 'CE', action: 'SELL',
    lots: 3, lotSize: 50, expiry: '2024-01-04', entryPrice: 200,
  }], 'NIFTY');

  expect(positions[0].NetQty).toBe(-3);
});

test('individual positions match leg count', () => {
  const legs = [
    { strike: 21700, optionType: 'CE' as const, action: 'SELL' as const, lots: 1, lotSize: 50, expiry: '2024-01-04', entryPrice: 200 },
    { strike: 21700, optionType: 'PE' as const, action: 'SELL' as const, lots: 1, lotSize: 50, expiry: '2024-01-04', entryPrice: 195 },
  ];
  const positions = tradeLegsToMarginPositions(legs, 'NIFTY');
  expect(positions.length).toBe(2);
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
