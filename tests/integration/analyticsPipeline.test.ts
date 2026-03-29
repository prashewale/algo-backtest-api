/**
 * Integration test — analytics pipeline.
 * Runs on synthetic BacktestResult (no DB needed).
 * Run: npx ts-node tests/integration/analyticsPipeline.test.ts
 */

import { computeExtendedAnalytics, ExtendedAnalytics } from '../../src/core/analytics/analytics';
import { BacktestResult, TradeRecord, EquityPoint } from '../../src/types';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}
function expect(v: any) {
  return {
    toBe:            (e: any)    => { if (v !== e) throw new Error(`Expected ${e}, got ${v}`); },
    toBeGreaterThan: (n: number) => { if (v <= n)  throw new Error(`Expected > ${n}, got ${v}`); },
    toBeLessThan:    (n: number) => { if (v >= n)  throw new Error(`Expected < ${n}, got ${v}`); },
    toBeWithin:      (a: number, b: number) => { if (v < a || v > b) throw new Error(`${v} not in [${a}, ${b}]`); },
    toExist:         ()           => { if (v == null) throw new Error(`Expected non-null, got ${v}`); },
    toBeArray:       ()           => { if (!Array.isArray(v)) throw new Error(`Expected array`); },
  };
}

// ─── Synthetic result ─────────────────────────────────────────────────────────

function makeSyntheticResult(): BacktestResult {
  const capital = 500_000;
  const trades: TradeRecord[] = [];
  const equityCurve: EquityPoint[] = [{ date: '2024-01-02', value: capital, drawdown: 0 }];
  const greeksTimeline = [];

  let equity = capital;
  let maxEquity = capital;

  const days = ['Mon','Tue','Wed','Thu','Fri'];
  const hours = [9, 10, 11, 14, 15];
  const exitReasons: TradeRecord['exitReason'][] = ['stop_loss','target','time_exit','condition_exit','eod'];

  for (let i = 0; i < 50; i++) {
    const date = new Date('2024-01-02');
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    const hour = hours[i % hours.length];
    const pnl = (Math.sin(i * 1.3) > 0 ? 1 : -1) * (500 + (i % 7) * 200);
    equity += pnl;
    if (equity > maxEquity) maxEquity = equity;
    const dd = ((maxEquity - equity) / maxEquity) * 100;

    trades.push({
      id: i + 1,
      entryCandle: `${dateStr}T${String(hour).padStart(2,'0')}:15:00`,
      exitCandle:  `${dateStr}T${String(hour).padStart(2,'0')}:45:00`,
      entryTime:   `${String(hour).padStart(2,'0')}:15`,
      exitTime:    `${String(hour).padStart(2,'0')}:45`,
      pnl,
      status: pnl > 0 ? 'WIN' : 'LOSS',
      exitReason: exitReasons[i % exitReasons.length],
      marginUsed: 80_000,
      netGreeks: { delta: 0, gamma: 0, theta: -3.5, vega: 40 },
      legs: [
        { legId: 'leg-ce', action: 'SELL', optionType: 'CE', expiry: '2024-01-04', strike: 21700, entryPrice: 200, exitPrice: 200 - pnl / 50, lots: 1, pnl: pnl * 0.6, greeksAtEntry: { delta: -0.5, theta: -3.5 } },
        { legId: 'leg-pe', action: 'SELL', optionType: 'PE', expiry: '2024-01-04', strike: 21700, entryPrice: 195, exitPrice: 195 - pnl / 50, lots: 1, pnl: pnl * 0.4, greeksAtEntry: { delta: 0.5, theta: -3.5 } },
      ],
      entryConditionSnapshot: { 'vix.close': 14.5, 'cash.close': 21726 },
    });

    equityCurve.push({ date: dateStr, value: Math.round(equity), drawdown: +dd.toFixed(2) });
    greeksTimeline.push({ date: dateStr, iv: 0.15 + Math.sin(i) * 0.02, delta: Math.sin(i) * 0.1, theta: -3.5, vega: 40, vix: 14.5 + Math.cos(i) * 2, spotPrice: 21700 + i * 10 });
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.length - wins;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);

  return {
    summary: {
      totalReturn: +((equity / capital - 1) * 100).toFixed(2),
      cagr: 12, sharpe: 1.5, sortino: 2.1, calmar: 1.2,
      maxDrawdown: 8.5, maxDrawdownDuration: 10,
      winRate: +(wins / trades.length * 100).toFixed(1),
      profitFactor: 1.8, totalTrades: trades.length, wins, losses,
      avgWin: 800, avgLoss: -600, netPnl: Math.round(netPnl),
      finalEquity: Math.round(equity), avgMarginUsed: 80_000,
      maxConsecutiveWins: 4, maxConsecutiveLosses: 3,
    },
    equityCurve,
    trades,
    monthlyPnl: [
      { month: '2024-01', pnl: 15000, trades: 20, winRate: 55 },
      { month: '2024-02', pnl: -5000, trades: 18, winRate: 40 },
      { month: '2024-03', pnl: 22000, trades: 12, winRate: 65 },
    ],
    greeksTimeline,
    conditionStats: {
      entryConditionFired: 50, entryConditionSkipped: 10,
      exitConditionFired: 5, slConditionFired: 8,
      targetConditionFired: 15, alertsFired: 3,
    },
  };
}

// ─── Run tests ────────────────────────────────────────────────────────────────

const result = makeSyntheticResult();
let analytics: ExtendedAnalytics;

console.log('\ncomputeExtendedAnalytics');

test('runs without error', () => {
  analytics = computeExtendedAnalytics(result);
});

// Streaks
console.log('\nStreak analysis');

test('longestWinStreak > 0', () => {
  expect(analytics.streaks.longestWinStreak).toBeGreaterThan(0);
});

test('longestLossStreak > 0', () => {
  expect(analytics.streaks.longestLossStreak).toBeGreaterThan(0);
});

test('currentStreakType is win or loss or none', () => {
  if (!['win','loss','none'].includes(analytics.streaks.currentStreakType)) {
    throw new Error(`Bad streak type: ${analytics.streaks.currentStreakType}`);
  }
});

test('streakDistribution is an array', () => {
  expect(analytics.streaks.streakDistribution).toBeArray();
});

// Return distribution
console.log('\nReturn distribution');

test('returnDistribution has 12 buckets', () => {
  expect(analytics.returnDistribution.length).toBe(12);
});

test('bucket counts sum to totalTrades', () => {
  const sum = analytics.returnDistribution.reduce((s, b) => s + b.count, 0);
  if (sum !== result.trades.length) throw new Error(`Bucket sum ${sum} ≠ trades ${result.trades.length}`);
});

test('each bucket pct is 0-100', () => {
  for (const b of analytics.returnDistribution) {
    if (b.pct < 0 || b.pct > 100) throw new Error(`Bad pct ${b.pct} in bucket ${b.label}`);
  }
});

// Hourly performance
console.log('\nHourly performance');

test('hourlyPerformance is an array', () => {
  expect(analytics.hourlyPerformance).toBeArray();
});

test('hourly entries have correct fields', () => {
  for (const h of analytics.hourlyPerformance) {
    if (h.trades < 0) throw new Error('Negative trade count');
    if (h.winRate < 0 || h.winRate > 100) throw new Error(`Bad win rate ${h.winRate}`);
    if (h.hour < 9 || h.hour > 15) throw new Error(`Bad hour ${h.hour}`);
  }
});

// Weekday performance
console.log('\nWeekday performance');

test('weekdayPerformance has Mon-Fri', () => {
  expect(analytics.weekdayPerformance).toBeArray();
  expect(analytics.weekdayPerformance.length).toBeGreaterThan(0);
});

test('weekday entries have valid dayNum 1-5', () => {
  for (const d of analytics.weekdayPerformance) {
    if (d.dayNum < 1 || d.dayNum > 5) throw new Error(`Bad dayNum ${d.dayNum}`);
  }
});

// Greeks correlation
console.log('\nGreeks correlation');

test('all correlation values in [-1, 1]', () => {
  const { deltaVsPnl, thetaVsPnl, ivVsPnl, vixVsPnl } = analytics.greeksCorrelation;
  for (const [k, v] of Object.entries({ deltaVsPnl, thetaVsPnl, ivVsPnl, vixVsPnl })) {
    if (v < -1 || v > 1) throw new Error(`${k} = ${v} out of [-1, 1]`);
  }
});

// Rolling Sharpe
console.log('\nRolling metrics');

test('rollingSharpe is an array', () => {
  expect(analytics.rollingSharpe).toBeArray();
});

test('rollingWinRate values are 0-100', () => {
  for (const r of analytics.rollingWinRate) {
    if (r.value < 0 || r.value > 100) throw new Error(`Bad rolling win rate ${r.value}`);
  }
});

// Exit reasons
console.log('\nExit reason breakdown');

test('exitReasonBreakdown covers all used reasons', () => {
  const reasons = analytics.exitReasonBreakdown.map(e => e.reason);
  for (const r of ['stop_loss','target','time_exit','condition_exit','eod']) {
    if (!reasons.includes(r)) throw new Error(`Missing reason: ${r}`);
  }
});

test('exit reason counts sum to totalTrades', () => {
  const sum = analytics.exitReasonBreakdown.reduce((s, e) => s + e.count, 0);
  if (sum !== result.trades.length) throw new Error(`Reason sum ${sum} ≠ ${result.trades.length}`);
});

// Leg contribution
console.log('\nLeg contribution');

test('legContribution has entries for both legs', () => {
  expect(analytics.legContribution.length).toBe(2);
});

test('pctOfTotal values sum to ~100', () => {
  const sum = analytics.legContribution.reduce((s, l) => s + l.pctOfTotal, 0);
  if (Math.abs(sum - 100) > 5) throw new Error(`pctOfTotal sum ${sum} ≠ 100`);
});

// IV buckets
console.log('\nIV bucket performance');

test('ivBucketPerformance is an array', () => {
  expect(analytics.ivBucketPerformance).toBeArray();
});

test('IV bucket win rates are 0-100', () => {
  for (const b of analytics.ivBucketPerformance) {
    if (b.winRate < 0 || b.winRate > 100) throw new Error(`Bad IV bucket win rate ${b.winRate}`);
  }
});

// ─── Final ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
