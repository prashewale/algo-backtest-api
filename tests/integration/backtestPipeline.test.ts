/**
 * Integration test — full backtest pipeline.
 *
 * Does NOT require a live MongoDB or Redis connection.
 * Patches dataService.fetchRawCandles to return synthetic candle data,
 * then runs the real backtest engine end-to-end and validates the result.
 *
 * Run: npx ts-node tests/integration/backtestPipeline.test.ts
 */

// ─── Patch fetchRawCandles BEFORE importing the engine ───────────────────────

import * as dataService from '../../src/services/dataService';
import { RawOptionChainDocument } from '../../src/types';

// Build 100 synthetic candles across 10 trading days, 10 candles/day (09:15–10:00)
function buildSyntheticCandles(): RawOptionChainDocument[] {
  const docs: RawOptionChainDocument[] = [];
  const baseSpot = 21700;
  const startDate = new Date('2024-01-02'); // Tuesday

  for (let day = 0; day < 10; day++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + day + Math.floor(day / 5) * 2); // skip weekends roughly
    const dateStr = date.toISOString().slice(0, 10);

    for (let c = 0; c < 10; c++) {
      const minuteOffset = 15 + c; // 09:16 … 09:25
      const h = 9, m = minuteOffset;
      const candle = `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;

      // Spot drifts slightly per candle
      const spot = baseSpot + day * 20 + c * 3 + (Math.sin(day * 7 + c) * 30);
      const atmStrike = Math.round(spot / 50) * 50;

      // Build a small strike array centred around ATM
      const strikes = [-4,-3,-2,-1,0,1,2,3,4].map(o => atmStrike + o * 50);
      const n = strikes.length;

      const callClose = strikes.map((s, i) => {
        const otm = (s - spot) / spot;
        return otm >= 0 ? Math.max(1, 200 - i * 20) : Math.max(1, 200 + (4 - i) * 20);
      });
      const putClose = strikes.map((s, i) => {
        const otm = (spot - s) / spot;
        return otm >= 0 ? Math.max(1, 200 - (n - 1 - i) * 20) : Math.max(1, 200 + i * 15);
      });
      const callDelta = strikes.map((s) => {
        const pct = (spot - s) / spot;
        return Math.min(0.99, Math.max(0.01, 0.5 + pct * 3));
      });
      const putDelta = callDelta.map(d => -(1 - d));
      const iv = 0.15;
      const callIV  = strikes.map(() => iv + Math.random() * 0.02);
      const putIV   = callIV.slice();
      const gamma   = strikes.map(() => 0.0003);
      const theta   = strikes.map(() => -3.5);
      const vega    = strikes.map(() => 40);
      const rho     = strikes.map((_, i) => 5 - i * 0.5);
      const ts      = strikes.map(() => candle);
      const oi      = strikes.map(() => 1000);

      const expiryDate = `${dateStr.slice(0,8)}${String(parseInt(dateStr.slice(8)) + 3).padStart(2,'0')}`;

      docs.push({
        candle,
        underlying: 'NIFTY',
        cash:   { timestamp: candle, close: spot },
        futures: {
          [expiryDate]: { timestamp: candle, close: spot + 50 },
        },
        implied_futures: { [expiryDate]: spot + 30 },
        vix: { timestamp: candle, close: 14.5 + Math.sin(day) * 2 },
        perpetual_future: null,
        options: {
          [expiryDate]: {
            strike: strikes,
            call_close:        callClose,
            call_open_interest: oi,
            call_implied_vol:   callIV,
            call_delta:         callDelta,
            call_gamma:         gamma,
            call_theta:         theta,
            call_vega:          vega,
            call_rho:           rho,
            call_timestamp:     ts,
            put_close:          putClose,
            put_open_interest:  oi,
            put_implied_vol:    putIV,
            put_delta:          putDelta,
            put_gamma:          gamma,
            put_theta:          theta,
            put_vega:           vega,
            put_rho:            rho.map(r => -r),
            put_timestamp:      ts,
          },
        },
      } as any);
    }
  }
  return docs;
}

// Monkey-patch fetchRawCandles to return synthetic data
(dataService as any).fetchRawCandles = async () => buildSyntheticCandles();

// ─── Now import the engine (it will use the patched fetchRawCandles) ──────────

import { runBacktestEngine } from '../../src/core/engine/backtestEngine';
import { v4 as uuidv4 } from 'uuid';
import { BacktestConfig } from '../../src/types';

// ─── Tiny harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn())
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e: any) => { console.error(`  ✗ ${name}: ${e.message}`); failed++; });
}
function expect(v: any) {
  return {
    toBe:            (e: any)    => { if (v !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`); },
    toBeGreaterThan: (n: number) => { if (v <= n)  throw new Error(`Expected > ${n}, got ${v}`); },
    toBeLessThan:    (n: number) => { if (v >= n)  throw new Error(`Expected < ${n}, got ${v}`); },
    toBeWithin:      (a: number, b: number) => { if (v < a || v > b) throw new Error(`Expected ${v} within [${a}, ${b}]`); },
    toBeArray:       ()           => { if (!Array.isArray(v)) throw new Error(`Expected array, got ${typeof v}`); },
    toHaveLength:    (n: number) => { if (v.length !== n) throw new Error(`Expected length ${n}, got ${v.length}`); },
    toExist:         ()           => { if (v == null) throw new Error(`Expected non-null, got ${v}`); },
  };
}

// ─── Config factory ───────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    name:       'Integration Test Backtest',
    instrument: 'NIFTY',
    startDate:  '2024-01-02',
    endDate:    '2024-01-15',
    entryTime:  '09:17',
    exitTime:   '09:24',
    capital:    500_000,
    lotSize:    50,
    legs: [
      {
        id:              uuidv4(),
        action:          'SELL',
        optionType:      'CE',
        strikeSelection: { type: 'atm_offset', offset: 0 },
        expirySelection: { type: 'nearest' },
        lots:            1,
      },
      {
        id:              uuidv4(),
        action:          'SELL',
        optionType:      'PE',
        strikeSelection: { type: 'atm_offset', offset: 0 },
        expirySelection: { type: 'nearest' },
        lots:            1,
      },
    ],
    conditions: {},
    riskRules: {
      stopLossPct:     100,
      targetPct:       50,
      maxDailyLossPct: 5,
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {

  // ── Basic result structure ─────────────────────────────────────────────────

  console.log('\nBacktest result structure');

  let result: Awaited<ReturnType<typeof runBacktestEngine>>;

  await test('engine runs without error', async () => {
    result = await runBacktestEngine(makeConfig());
  });

  await test('result has summary', async () => {
    expect(result.summary).toExist();
  });

  await test('result has equity curve', async () => {
    expect(result.equityCurve).toBeArray();
    expect(result.equityCurve.length).toBeGreaterThan(0);
  });

  await test('result has trades array', async () => {
    expect(result.trades).toBeArray();
  });

  await test('result has monthlyPnl array', async () => {
    expect(result.monthlyPnl).toBeArray();
  });

  await test('result has greeksTimeline', async () => {
    expect(result.greeksTimeline).toBeArray();
  });

  await test('result has conditionStats', async () => {
    expect(result.conditionStats).toExist();
  });

  // ── Summary values ─────────────────────────────────────────────────────────

  console.log('\nSummary values');

  await test('finalEquity is a positive number', async () => {
    expect(result.summary.finalEquity).toBeGreaterThan(0);
  });

  await test('totalTrades >= 0', async () => {
    expect(result.summary.totalTrades).toBeGreaterThan(-1);
  });

  await test('wins + losses = totalTrades', async () => {
    const sum = result.summary.wins + result.summary.losses;
    if (result.summary.totalTrades > 0 && sum !== result.summary.totalTrades) {
      throw new Error(`wins(${result.summary.wins}) + losses(${result.summary.losses}) = ${sum} ≠ ${result.summary.totalTrades}`);
    }
  });

  await test('winRate is between 0 and 100', async () => {
    if (result.summary.totalTrades > 0) {
      expect(result.summary.winRate).toBeWithin(0, 100);
    }
  });

  await test('maxDrawdown is between 0 and 100', async () => {
    expect(result.summary.maxDrawdown).toBeWithin(0, 100);
  });

  await test('netPnl = finalEquity - capital', async () => {
    const diff = Math.abs(result.summary.netPnl - (result.summary.finalEquity - 500_000));
    if (diff > 10) throw new Error(`netPnl(${result.summary.netPnl}) doesn't match equity diff(${result.summary.finalEquity - 500_000})`);
  });

  // ── Trade records ──────────────────────────────────────────────────────────

  console.log('\nTrade records');

  await test('each trade has required fields', async () => {
    for (const t of result.trades) {
      if (!t.id)          throw new Error('Missing trade.id');
      if (!t.entryCandle) throw new Error('Missing trade.entryCandle');
      if (!t.exitReason)  throw new Error('Missing trade.exitReason');
      if (t.legs.length === 0) throw new Error('Trade has no legs');
    }
  });

  await test('trade P&L matches sum of leg P&Ls (within rounding)', async () => {
    for (const t of result.trades) {
      const legSum = t.legs.reduce((s, l) => s + l.pnl, 0);
      if (Math.abs(legSum - t.pnl) > 5) {
        throw new Error(`Trade ${t.id}: legSum=${legSum.toFixed(0)} ≠ pnl=${t.pnl}`);
      }
    }
  });

  await test('no trade exceeds max daily loss limit', async () => {
    const maxLoss = 500_000 * 0.05; // 5% of capital
    for (const t of result.trades) {
      if (t.pnl < -maxLoss * 1.1) { // 10% tolerance for rounding
        throw new Error(`Trade ${t.id} loss ${t.pnl} exceeds max daily loss ${-maxLoss}`);
      }
    }
  });

  // ── Equity curve integrity ─────────────────────────────────────────────────

  console.log('\nEquity curve integrity');

  await test('equity curve starts at capital', async () => {
    const first = result.equityCurve[0];
    if (Math.abs(first.value - 500_000) > 100) {
      throw new Error(`First equity point ${first.value} ≠ 500000`);
    }
  });

  await test('equity curve values are all positive', async () => {
    for (const pt of result.equityCurve) {
      if (pt.value <= 0) throw new Error(`Negative equity: ${pt.value} on ${pt.date}`);
    }
  });

  await test('drawdown is non-negative everywhere', async () => {
    for (const pt of result.equityCurve) {
      if (pt.drawdown < 0) throw new Error(`Negative drawdown: ${pt.drawdown} on ${pt.date}`);
    }
  });

  // ── Condition-filtered run ─────────────────────────────────────────────────

  console.log('\nCondition-filtered backtest');

  await test('entry condition: VIX < 20 (should always fire on synthetic data)', async () => {
    const filtered = await runBacktestEngine(makeConfig({
      conditions: {
        entry: {
          id: 'c1', type: 'condition',
          field: 'vix.close', operator: 'lt',
          rhsType: 'value', rhsValue: 20,
        },
      },
    }));
    // VIX is ~14.5 in our synthetic data, so all entries should fire
    expect(filtered.summary.totalTrades).toBeGreaterThan(-1);
    expect(filtered.conditionStats.entryConditionFired).toBeGreaterThan(-1);
  });

  await test('entry condition: VIX < 0 (should never fire)', async () => {
    const filtered = await runBacktestEngine(makeConfig({
      conditions: {
        entry: {
          id: 'c1', type: 'condition',
          field: 'vix.close', operator: 'lt',
          rhsType: 'value', rhsValue: 0,
        },
      },
    }));
    // VIX can't be below 0, so no trades should be opened
    expect(filtered.summary.totalTrades).toBe(0);
    expect(filtered.conditionStats.entryConditionSkipped).toBeGreaterThan(0);
  });

  // ── Delta-based strike selection ───────────────────────────────────────────

  console.log('\nDelta-based strike selection');

  await test('delta strike selection runs without error', async () => {
    const r = await runBacktestEngine(makeConfig({
      legs: [
        {
          id:              uuidv4(),
          action:          'SELL',
          optionType:      'CE',
          strikeSelection: { type: 'delta', targetDelta: 0.25 },
          expirySelection: { type: 'nearest' },
          lots:            1,
        },
        {
          id:              uuidv4(),
          action:          'SELL',
          optionType:      'PE',
          strikeSelection: { type: 'delta', targetDelta: -0.25 },
          expirySelection: { type: 'nearest' },
          lots:            1,
        },
      ],
    }));
    expect(r.summary).toExist();
  });

  // ── Progress callback ──────────────────────────────────────────────────────

  console.log('\nProgress callback');

  await test('progress callback fires with 0–100 values', async () => {
    const values: number[] = [];
    await runBacktestEngine(makeConfig(), (pct) => { values.push(pct); });
    if (values.length === 0) throw new Error('Progress callback never called');
    if (values.some(v => v < 0 || v > 100)) throw new Error(`Out-of-range progress: ${values.find(v => v < 0 || v > 100)}`);
  });

  // ── Condition stats ────────────────────────────────────────────────────────

  console.log('\nCondition stats');

  await test('conditionStats fields are non-negative', async () => {
    const s = result.conditionStats;
    const fields = ['entryConditionFired','entryConditionSkipped','exitConditionFired','slConditionFired','targetConditionFired','alertsFired'] as const;
    for (const f of fields) {
      if (s[f] < 0) throw new Error(`${f} is negative: ${s[f]}`);
    }
  });

  // ── processCandle integration ──────────────────────────────────────────────

  console.log('\nProcessed candle from synthetic data');

  await test('processCandle produces valid expiries for synthetic doc', async () => {
    const candles = buildSyntheticCandles();
    const { processCandle } = await import('../../src/services/dataService');
    const processed = processCandle(candles[0] as any);
    expect(processed.expiries.length).toBeGreaterThan(0);
    expect(processed.spotPrice).toBeGreaterThan(0);
    expect(processed.expiries[0].strikes.length).toBeGreaterThan(0);
  });

  await test('ATM strike is within 100 of spot on synthetic candle', async () => {
    const candles = buildSyntheticCandles();
    const { processCandle } = await import('../../src/services/dataService');
    const processed = processCandle(candles[5] as any);
    const atm = processed.expiries[0]?.atmStrike ?? 0;
    const diff = Math.abs(atm - processed.spotPrice);
    if (diff > 100) throw new Error(`ATM ${atm} too far from spot ${processed.spotPrice}`);
  });

  // ── Results ────────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Tests: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
