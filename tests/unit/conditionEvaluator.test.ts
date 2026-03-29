/**
 * Unit tests for the condition tree evaluator.
 * Run: npx ts-node tests/unit/conditionEvaluator.test.ts
 */

import { evaluateConditionTree, EvalContext } from '../../src/core/conditions/evaluator';
import { ProcessedCandle, ProcessedExpiry, ProcessedStrike, ConditionNode, ConditionGroup } from '../../src/types';

// ─── Tiny harness ────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}
function expect(v: any) {
  return {
    toBe:      (e: any) => { if (v !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`); },
    toBeTrue:  ()       => { if (v !== true)  throw new Error(`Expected true, got ${JSON.stringify(v)}`); },
    toBeFalse: ()       => { if (v !== false) throw new Error(`Expected false, got ${JSON.stringify(v)}`); },
  };
}

// ─── Mock candle builder ──────────────────────────────────────────────────────

function makeCandle(overrides: {
  spot?: number;
  vix?: number;
  atmCallDelta?: number;
  atmCallIV?: number;
  atmCallClose?: number;
  atmPutClose?: number;
  atmPutDelta?: number;
  daysToExpiry?: number;
  minutesSinceOpen?: number;
} = {}): ProcessedCandle {
  const spot = overrides.spot ?? 21726;
  const atmStrike = Math.round(spot / 50) * 50;

  const atmCallClose = overrides.atmCallClose ?? 200;
  const atmPutClose  = overrides.atmPutClose  ?? 195;

  const atmStrikeObj: ProcessedStrike = {
    strike:          atmStrike,
    moneyness:       'atm',
    strikePctFromAtm: 0,
    call: {
      close:       atmCallClose,
      openInterest: 1000,
      impliedVol:  overrides.atmCallIV   ?? 0.15,
      delta:       overrides.atmCallDelta ?? 0.50,
      gamma:       0.0003,
      theta:       -3.5,
      vega:        40,
      rho:         5,
      timestamp:   '2024-01-01T09:30:00',
    },
    put: {
      close:       atmPutClose,
      openInterest: 800,
      impliedVol:  overrides.atmCallIV   ?? 0.15,
      delta:       overrides.atmPutDelta ?? -0.50,
      gamma:       0.0003,
      theta:       -3.5,
      vega:        40,
      rho:         -5,
      timestamp:   '2024-01-01T09:30:00',
    },
  };

  const minutesSinceOpen = overrides.minutesSinceOpen ?? 15;
  const h = 9 + Math.floor((minutesSinceOpen + 15) / 60);
  const m = (minutesSinceOpen + 15) % 60;

  const expiry: ProcessedExpiry = {
    expiry:          '2024-01-04',
    daysToExpiry:    overrides.daysToExpiry ?? 3,
    impliedFuture:   spot,
    strikes:         [atmStrikeObj],
    atmStrike,
    atmIndex:        0,
    straddlePremium: atmCallClose + atmPutClose,
    pcr:             0.8,
    maxPainStrike:   atmStrike,
    ivSkew:          0,
  };

  const date = new Date(`2024-01-01T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);

  return {
    candle:        date,
    underlying:    'NIFTY',
    spotPrice:     spot,
    vix:           overrides.vix ?? 14.5,
    expiries:      [expiry],
    futures:       { '2024-01-04': spot + 50 },
    impliedFutures:{ '2024-01-04': spot + 30 },
  };
}

// ─── Simple condition builder helpers ────────────────────────────────────────

const cond = (id: string, field: string, operator: any, rhsType: any, rhsValue?: number, extras?: Partial<ConditionNode>): ConditionNode => ({
  id, type: 'condition', field, operator, rhsType, rhsValue, ...extras,
});

const group = (id: string, logic: 'AND'|'OR'|'NOT', ...children: any[]): ConditionGroup => ({
  id, type: 'group', logic, children,
});

// ─── cash.close tests ────────────────────────────────────────────────────────

console.log('\ncash.close field');

test('gt passes when spot > value', () => {
  const ctx: EvalContext = { current: makeCandle({ spot: 21726 }) };
  const c = cond('c1', 'cash.close', 'gt', 'value', 21000);
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

test('gt fails when spot <= value', () => {
  const ctx: EvalContext = { current: makeCandle({ spot: 21726 }) };
  const c = cond('c1', 'cash.close', 'gt', 'value', 22000);
  expect(evaluateConditionTree(c, ctx)).toBeFalse();
});

test('is_between passes when spot in range', () => {
  const ctx: EvalContext = { current: makeCandle({ spot: 21726 }) };
  const c = cond('c1', 'cash.close', 'is_between', 'value', undefined, { rhsFrom: 21000, rhsTo: 22000 });
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

test('is_between fails outside range', () => {
  const ctx: EvalContext = { current: makeCandle({ spot: 21726 }) };
  const c = cond('c1', 'cash.close', 'is_between', 'value', undefined, { rhsFrom: 22000, rhsTo: 23000 });
  expect(evaluateConditionTree(c, ctx)).toBeFalse();
});

// ─── vix.close tests ─────────────────────────────────────────────────────────

console.log('\nvix.close field');

test('lt passes when VIX < threshold', () => {
  const ctx: EvalContext = { current: makeCandle({ vix: 14.5 }) };
  const c = cond('c1', 'vix.close', 'lt', 'value', 18);
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

test('lt fails when VIX >= threshold', () => {
  const ctx: EvalContext = { current: makeCandle({ vix: 22 }) };
  const c = cond('c1', 'vix.close', 'lt', 'value', 18);
  expect(evaluateConditionTree(c, ctx)).toBeFalse();
});

// ─── call.delta tests ─────────────────────────────────────────────────────────

console.log('\ncall.delta field');

test('ATM call delta ~ 0.5', () => {
  const ctx: EvalContext = { current: makeCandle({ atmCallDelta: 0.50 }) };
  const c = cond('c1', 'call.delta', 'is_between', 'value', undefined, { rhsFrom: 0.45, rhsTo: 0.55 });
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

// ─── straddle_premium tests ───────────────────────────────────────────────────

console.log('\nstraddle_premium');

test('straddle = call + put close', () => {
  const ctx: EvalContext = { current: makeCandle({ atmCallClose: 200, atmPutClose: 195 }) };
  const c = cond('c1', 'straddle_premium', 'eq', 'value', 395);
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

test('straddle > threshold passes', () => {
  const ctx: EvalContext = { current: makeCandle({ atmCallClose: 250, atmPutClose: 250 }) };
  const c = cond('c1', 'straddle_premium', 'gt', 'value', 400);
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

// ─── time.days_to_expiry tests ────────────────────────────────────────────────

console.log('\ntime.days_to_expiry');

test('DTE = 3 passes gte 1', () => {
  const ctx: EvalContext = { current: makeCandle({ daysToExpiry: 3 }) };
  const c = cond('c1', 'time.days_to_expiry', 'gte', 'value', 1);
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

test('DTE = 3 fails gt 5', () => {
  const ctx: EvalContext = { current: makeCandle({ daysToExpiry: 3 }) };
  const c = cond('c1', 'time.days_to_expiry', 'gt', 'value', 5);
  expect(evaluateConditionTree(c, ctx)).toBeFalse();
});

// ─── time.minutes_since_open tests ───────────────────────────────────────────

console.log('\ntime.minutes_since_open');

test('15 min since open passes gt 10', () => {
  const ctx: EvalContext = { current: makeCandle({ minutesSinceOpen: 15 }) };
  const c = cond('c1', 'time.minutes_since_open', 'gt', 'value', 10);
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

test('15 min since open fails gt 30', () => {
  const ctx: EvalContext = { current: makeCandle({ minutesSinceOpen: 15 }) };
  const c = cond('c1', 'time.minutes_since_open', 'gt', 'value', 30);
  expect(evaluateConditionTree(c, ctx)).toBeFalse();
});

// ─── AND group tests ──────────────────────────────────────────────────────────

console.log('\nAND group');

test('AND passes when all children pass', () => {
  const ctx: EvalContext = { current: makeCandle({ vix: 14.5, spot: 21726 }) };
  const g = group('g1', 'AND',
    cond('c1', 'vix.close',   'lt', 'value', 18),
    cond('c2', 'cash.close',  'gt', 'value', 21000),
  );
  expect(evaluateConditionTree(g, ctx)).toBeTrue();
});

test('AND fails when any child fails', () => {
  const ctx: EvalContext = { current: makeCandle({ vix: 22, spot: 21726 }) };
  const g = group('g1', 'AND',
    cond('c1', 'vix.close',  'lt', 'value', 18),   // FAILS (22 < 18 = false)
    cond('c2', 'cash.close', 'gt', 'value', 21000), // passes
  );
  expect(evaluateConditionTree(g, ctx)).toBeFalse();
});

// ─── OR group tests ───────────────────────────────────────────────────────────

console.log('\nOR group');

test('OR passes when at least one child passes', () => {
  const ctx: EvalContext = { current: makeCandle({ vix: 22, spot: 21726 }) };
  const g = group('g1', 'OR',
    cond('c1', 'vix.close',  'lt', 'value', 18),   // fails
    cond('c2', 'cash.close', 'gt', 'value', 21000), // passes
  );
  expect(evaluateConditionTree(g, ctx)).toBeTrue();
});

test('OR fails when all children fail', () => {
  const ctx: EvalContext = { current: makeCandle({ vix: 22, spot: 21726 }) };
  const g = group('g1', 'OR',
    cond('c1', 'vix.close',  'lt', 'value', 18),   // fails
    cond('c2', 'cash.close', 'gt', 'value', 25000), // fails
  );
  expect(evaluateConditionTree(g, ctx)).toBeFalse();
});

// ─── NOT group tests ──────────────────────────────────────────────────────────

console.log('\nNOT group');

test('NOT inverts a passing condition', () => {
  const ctx: EvalContext = { current: makeCandle({ vix: 14.5 }) };
  const g = group('g1', 'NOT', cond('c1', 'vix.close', 'lt', 'value', 18)); // lt passes → NOT = false
  expect(evaluateConditionTree(g, ctx)).toBeFalse();
});

test('NOT inverts a failing condition', () => {
  const ctx: EvalContext = { current: makeCandle({ vix: 22 }) };
  const g = group('g1', 'NOT', cond('c1', 'vix.close', 'lt', 'value', 18)); // lt fails → NOT = true
  expect(evaluateConditionTree(g, ctx)).toBeTrue();
});

// ─── Deep nested tests ────────────────────────────────────────────────────────

console.log('\nDeep nested (AND(OR, NOT))');

test('AND(OR(vix<18, vix<25), NOT(spot>22000))', () => {
  // VIX=20 (fails vix<18, passes vix<25) → OR passes
  // spot=21726 (fails spot>22000) → NOT passes
  // AND(true, true) = true
  const ctx: EvalContext = { current: makeCandle({ vix: 20, spot: 21726 }) };
  const g = group('root', 'AND',
    group('g-or', 'OR',
      cond('c1', 'vix.close',  'lt', 'value', 18),
      cond('c2', 'vix.close',  'lt', 'value', 25),
    ),
    group('g-not', 'NOT',
      cond('c3', 'cash.close', 'gt', 'value', 22000),
    ),
  );
  expect(evaluateConditionTree(g, ctx)).toBeTrue();
});

// ─── crosses_above tests ──────────────────────────────────────────────────────

console.log('\ncrosses_above');

test('crosses_above: prev below, current above', () => {
  const prev = makeCandle({ spot: 21500 });
  const curr = makeCandle({ spot: 21800 });
  const ctx: EvalContext = { current: curr, previous: prev };
  const c = cond('c1', 'cash.close', 'crosses_above', 'value', 21700);
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

test('crosses_above fails when both above', () => {
  const prev = makeCandle({ spot: 21800 });
  const curr = makeCandle({ spot: 21900 });
  const ctx: EvalContext = { current: curr, previous: prev };
  const c = cond('c1', 'cash.close', 'crosses_above', 'value', 21700);
  expect(evaluateConditionTree(c, ctx)).toBeFalse();
});

test('crosses_below: prev above, current below', () => {
  const prev = makeCandle({ spot: 22000 });
  const curr = makeCandle({ spot: 21600 });
  const ctx: EvalContext = { current: curr, previous: prev };
  const c = cond('c1', 'cash.close', 'crosses_below', 'value', 21700);
  expect(evaluateConditionTree(c, ctx)).toBeTrue();
});

// ─── undefined tree ───────────────────────────────────────────────────────────

console.log('\nEdge cases');

test('undefined tree returns true (no condition = always fire)', () => {
  const ctx: EvalContext = { current: makeCandle() };
  expect(evaluateConditionTree(undefined, ctx)).toBeTrue();
});

test('field not found returns false', () => {
  const ctx: EvalContext = { current: makeCandle() };
  const c = cond('c1', 'nonexistent.field', 'gt', 'value', 0);
  expect(evaluateConditionTree(c, ctx)).toBeFalse();
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
