/**
 * Advanced analytics computed on top of BacktestResult.
 * Call after the backtest engine completes to enrich results.
 */

import {
  BacktestResult, TradeRecord, EquityPoint,
  MonthlyPnl, GreeksTimelinePoint,
} from '../../types';

// ─── Extended analytics types ─────────────────────────────────────────────────

export interface ExtendedAnalytics {
  drawdownPeriods:     DrawdownPeriod[];
  streaks:             StreakAnalysis;
  returnDistribution:  ReturnBucket[];
  hourlyPerformance:   HourlyPerf[];
  weekdayPerformance:  WeekdayPerf[];
  greeksCorrelation:   GreeksCorrelation;
  rollingSharpe:       RollingMetric[];
  rollingWinRate:      RollingMetric[];
  exitReasonBreakdown: ExitReasonStat[];
  legContribution:     LegContribution[];
  ivBucketPerformance: IvBucketPerf[];
}

export interface DrawdownPeriod {
  start:         string;
  end:           string;
  depth:         number;   // % max drawdown in this period
  durationDays:  number;
  recoveryDays:  number | null;
  tradesInDip:   number;
}

export interface StreakAnalysis {
  currentStreak:    number;
  currentStreakType: 'win' | 'loss' | 'none';
  longestWinStreak:  number;
  longestLossStreak: number;
  avgWinStreak:      number;
  avgLossStreak:     number;
  streakDistribution: { length: number; count: number; type: 'win' | 'loss' }[];
}

export interface ReturnBucket {
  label:  string;   // e.g. "< -5000", "-5000 to -2500", …
  from:   number;
  to:     number;
  count:  number;
  pct:    number;
}

export interface HourlyPerf {
  hour:      number;   // 9–15
  trades:    number;
  totalPnl:  number;
  winRate:   number;
  avgPnl:    number;
}

export interface WeekdayPerf {
  day:       string;   // "Mon"…"Fri"
  dayNum:    number;
  trades:    number;
  totalPnl:  number;
  winRate:   number;
  avgPnl:    number;
}

export interface GreeksCorrelation {
  deltaVsPnl:  number;   // Pearson correlation
  thetaVsPnl:  number;
  ivVsPnl:     number;
  vixVsPnl:    number;
}

export interface RollingMetric {
  date:  string;
  value: number;
}

export interface ExitReasonStat {
  reason:   string;
  count:    number;
  pct:      number;
  avgPnl:   number;
  totalPnl: number;
  winRate:  number;
}

export interface LegContribution {
  legId:    string;
  action:   string;
  optionType: string;
  totalPnl: number;
  avgPnl:   number;
  pctOfTotal: number;
}

export interface IvBucketPerf {
  label:    string;
  ivMin:    number;
  ivMax:    number;
  trades:   number;
  totalPnl: number;
  winRate:  number;
  avgPnl:   number;
}

// ─── Main analytics function ──────────────────────────────────────────────────

export function computeExtendedAnalytics(result: BacktestResult): ExtendedAnalytics {
  const { trades, equityCurve, greeksTimeline, monthlyPnl } = result;

  return {
    drawdownPeriods:     analyzeDrawdowns(equityCurve),
    streaks:             analyzeStreaks(trades),
    returnDistribution:  buildReturnDistribution(trades),
    hourlyPerformance:   analyzeHourly(trades),
    weekdayPerformance:  analyzeWeekday(trades),
    greeksCorrelation:   computeGreeksCorrelation(trades, greeksTimeline),
    rollingSharpe:       computeRollingSharpe(equityCurve, 30),
    rollingWinRate:      computeRollingWinRate(trades, 20),
    exitReasonBreakdown: analyzeExitReasons(trades),
    legContribution:     analyzeLegContribution(trades),
    ivBucketPerformance: analyzeIvBuckets(trades, greeksTimeline),
  };
}

// ─── Drawdown periods ─────────────────────────────────────────────────────────

function analyzeDrawdowns(curve: EquityPoint[]): DrawdownPeriod[] {
  const periods: DrawdownPeriod[] = [];
  let peakIdx = 0;
  let inDd = false;
  let ddStart = 0;

  for (let i = 1; i < curve.length; i++) {
    if (curve[i].value > curve[peakIdx].value) {
      if (inDd) {
        const recoveryDays = daysBetween(curve[ddStart].date, curve[i].date);
        const depth = ((curve[peakIdx].value - Math.min(...curve.slice(ddStart, i).map(e => e.value))) / curve[peakIdx].value) * 100;
        periods.push({
          start:        curve[ddStart].date,
          end:          curve[i].date,
          depth:        +depth.toFixed(2),
          durationDays: daysBetween(curve[ddStart].date, curve[i].date),
          recoveryDays,
          tradesInDip:  0, // filled below
        });
        inDd = false;
      }
      peakIdx = i;
    } else if (curve[i].drawdown > 2 && !inDd) {
      inDd = true;
      ddStart = i;
    }
  }

  // Open drawdown at end of series
  if (inDd) {
    const depth = ((curve[peakIdx].value - Math.min(...curve.slice(ddStart).map(e => e.value))) / curve[peakIdx].value) * 100;
    periods.push({
      start:        curve[ddStart].date,
      end:          curve[curve.length - 1].date,
      depth:        +depth.toFixed(2),
      durationDays: daysBetween(curve[ddStart].date, curve[curve.length - 1].date),
      recoveryDays: null,
      tradesInDip:  0,
    });
  }

  return periods.sort((a, b) => b.depth - a.depth).slice(0, 10);
}

// ─── Streak analysis ──────────────────────────────────────────────────────────

function analyzeStreaks(trades: TradeRecord[]): StreakAnalysis {
  const winStreaks: number[] = [];
  const lossStreaks: number[] = [];
  const all: { length: number; type: 'win' | 'loss' }[] = [];

  let curType: 'win' | 'loss' | null = null;
  let curLen = 0;

  for (const t of trades) {
    const type: 'win' | 'loss' = t.pnl >= 0 ? 'win' : 'loss';
    if (type === curType) {
      curLen++;
    } else {
      if (curType && curLen > 0) {
        all.push({ length: curLen, type: curType });
        if (curType === 'win') winStreaks.push(curLen);
        else lossStreaks.push(curLen);
      }
      curType = type;
      curLen = 1;
    }
  }
  if (curType && curLen > 0) {
    all.push({ length: curLen, type: curType });
    if (curType === 'win') winStreaks.push(curLen);
    else lossStreaks.push(curLen);
  }

  // Distribution
  const dist = new Map<string, number>();
  for (const s of all) {
    const key = `${s.type}-${s.length}`;
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }

  return {
    currentStreak:     all.at(-1)?.length ?? 0,
    currentStreakType:  all.at(-1)?.type ?? 'none',
    longestWinStreak:  winStreaks.length  ? Math.max(...winStreaks)  : 0,
    longestLossStreak: lossStreaks.length ? Math.max(...lossStreaks) : 0,
    avgWinStreak:      winStreaks.length  ? avg(winStreaks)  : 0,
    avgLossStreak:     lossStreaks.length ? avg(lossStreaks) : 0,
    streakDistribution: Array.from(dist.entries()).map(([key, count]) => {
      const [type, len] = key.split('-');
      return { type: type as 'win' | 'loss', length: parseInt(len), count };
    }).sort((a, b) => b.count - a.count),
  };
}

// ─── Return distribution (histogram) ─────────────────────────────────────────

function buildReturnDistribution(trades: TradeRecord[]): ReturnBucket[] {
  if (!trades.length) return [];
  const pnls = trades.map(t => t.pnl);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const bucketCount = 12;
  const step = (max - min) / bucketCount || 1000;

  const buckets: ReturnBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const from = min + i * step;
    const to   = from + step;
    const inBucket = trades.filter(t => t.pnl >= from && (i === bucketCount - 1 ? t.pnl <= to : t.pnl < to));
    buckets.push({
      label: `${formatPnl(from)} to ${formatPnl(to)}`,
      from:  +from.toFixed(0),
      to:    +to.toFixed(0),
      count: inBucket.length,
      pct:   +((inBucket.length / trades.length) * 100).toFixed(1),
    });
  }
  return buckets;
}

// ─── Hourly performance ───────────────────────────────────────────────────────

function analyzeHourly(trades: TradeRecord[]): HourlyPerf[] {
  const map = new Map<number, TradeRecord[]>();
  for (const t of trades) {
    const h = parseInt(t.entryTime.split(':')[0]);
    if (!map.has(h)) map.set(h, []);
    map.get(h)!.push(t);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a - b)
    .map(([hour, ts]) => ({
      hour,
      trades:   ts.length,
      totalPnl: Math.round(ts.reduce((s, t) => s + t.pnl, 0)),
      winRate:  +((ts.filter(t => t.pnl > 0).length / ts.length) * 100).toFixed(1),
      avgPnl:   Math.round(ts.reduce((s, t) => s + t.pnl, 0) / ts.length),
    }));
}

// ─── Weekday performance ──────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function analyzeWeekday(trades: TradeRecord[]): WeekdayPerf[] {
  const map = new Map<number, TradeRecord[]>();
  for (const t of trades) {
    const d = new Date(t.entryCandle).getDay();
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(t);
  }
  return [1, 2, 3, 4, 5].map(d => {
    const ts = map.get(d) ?? [];
    return {
      day:      DAYS[d],
      dayNum:   d,
      trades:   ts.length,
      totalPnl: Math.round(ts.reduce((s, t) => s + t.pnl, 0)),
      winRate:  ts.length ? +((ts.filter(t => t.pnl > 0).length / ts.length) * 100).toFixed(1) : 0,
      avgPnl:   ts.length ? Math.round(ts.reduce((s, t) => s + t.pnl, 0) / ts.length) : 0,
    };
  }).filter(d => d.trades > 0);
}

// ─── Greeks correlation ───────────────────────────────────────────────────────

function computeGreeksCorrelation(
  trades: TradeRecord[],
  greeksLog: GreeksTimelinePoint[],
): GreeksCorrelation {
  // Match each trade to the nearest Greeks snapshot by date
  const byDate = new Map(greeksLog.map(g => [g.date, g]));

  const delta: number[] = [], theta: number[] = [], iv: number[] = [],
        vix: number[] = [], pnl: number[] = [];

  for (const t of trades) {
    const d = t.entryCandle.slice(0, 10);
    const g = byDate.get(d);
    if (!g) continue;
    delta.push(g.delta); theta.push(g.theta);
    iv.push(g.iv);       vix.push(g.vix);
    pnl.push(t.pnl);
  }

  return {
    deltaVsPnl: +pearson(delta, pnl).toFixed(3),
    thetaVsPnl: +pearson(theta, pnl).toFixed(3),
    ivVsPnl:    +pearson(iv,    pnl).toFixed(3),
    vixVsPnl:   +pearson(vix,   pnl).toFixed(3),
  };
}

// ─── Rolling Sharpe (window = N equity points) ────────────────────────────────

function computeRollingSharpe(curve: EquityPoint[], window: number): RollingMetric[] {
  const result: RollingMetric[] = [];
  for (let i = window; i < curve.length; i++) {
    const slice = curve.slice(i - window, i + 1);
    const returns = slice.slice(1).map((e, j) =>
      slice[j].value > 0 ? (e.value - slice[j].value) / slice[j].value : 0
    );
    const avgR = avg(returns);
    const sd   = stdDev(returns);
    const sharpe = sd > 0 ? +(avgR / sd * Math.sqrt(252)).toFixed(2) : 0;
    result.push({ date: curve[i].date, value: sharpe });
  }
  // Downsample to max 200 points for response size
  return downsample(result, 200);
}

// ─── Rolling win rate (last N trades) ────────────────────────────────────────

function computeRollingWinRate(trades: TradeRecord[], window: number): RollingMetric[] {
  return trades.slice(window).map((_, i) => {
    const slice = trades.slice(i, i + window);
    const wr = slice.filter(t => t.pnl > 0).length / window * 100;
    return { date: trades[i + window - 1].entryCandle.slice(0, 10), value: +wr.toFixed(1) };
  });
}

// ─── Exit reason stats ────────────────────────────────────────────────────────

function analyzeExitReasons(trades: TradeRecord[]): ExitReasonStat[] {
  const map = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    if (!map.has(t.exitReason)) map.set(t.exitReason, []);
    map.get(t.exitReason)!.push(t);
  }
  return Array.from(map.entries()).map(([reason, ts]) => ({
    reason,
    count:    ts.length,
    pct:      +((ts.length / trades.length) * 100).toFixed(1),
    avgPnl:   Math.round(avg(ts.map(t => t.pnl))),
    totalPnl: Math.round(ts.reduce((s, t) => s + t.pnl, 0)),
    winRate:  +((ts.filter(t => t.pnl > 0).length / ts.length) * 100).toFixed(1),
  })).sort((a, b) => b.count - a.count);
}

// ─── Leg contribution ─────────────────────────────────────────────────────────

function analyzeLegContribution(trades: TradeRecord[]): LegContribution[] {
  const map = new Map<string, { pnls: number[]; action: string; type: string }>();
  const totalAbsPnl = trades.reduce((s, t) => s + Math.abs(t.pnl), 0);

  for (const t of trades) {
    for (const leg of t.legs) {
      const key = leg.legId;
      if (!map.has(key)) map.set(key, { pnls: [], action: leg.action, type: leg.optionType });
      map.get(key)!.pnls.push(leg.pnl);
    }
  }

  return Array.from(map.entries()).map(([legId, { pnls, action, type }]) => {
    const total = pnls.reduce((s, p) => s + p, 0);
    return {
      legId,
      action,
      optionType: type,
      totalPnl:   Math.round(total),
      avgPnl:     Math.round(avg(pnls)),
      pctOfTotal: totalAbsPnl > 0 ? +((Math.abs(total) / totalAbsPnl) * 100).toFixed(1) : 0,
    };
  }).sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
}

// ─── IV bucket performance ────────────────────────────────────────────────────

function analyzeIvBuckets(
  trades: TradeRecord[],
  greeksLog: GreeksTimelinePoint[],
): IvBucketPerf[] {
  const byDate = new Map(greeksLog.map(g => [g.date, g]));
  const buckets = [
    { label: 'Low IV (<12%)',     ivMin: 0,    ivMax: 0.12 },
    { label: 'Normal IV (12-18%)',ivMin: 0.12, ivMax: 0.18 },
    { label: 'High IV (18-25%)',  ivMin: 0.18, ivMax: 0.25 },
    { label: 'Extreme IV (>25%)', ivMin: 0.25, ivMax: 1.0  },
  ];

  return buckets.map(b => {
    const ts = trades.filter(t => {
      const g = byDate.get(t.entryCandle.slice(0, 10));
      return g && g.iv >= b.ivMin && g.iv < b.ivMax;
    });
    return {
      ...b,
      trades:   ts.length,
      totalPnl: Math.round(ts.reduce((s, t) => s + t.pnl, 0)),
      winRate:  ts.length ? +((ts.filter(t => t.pnl > 0).length / ts.length) * 100).toFixed(1) : 0,
      avgPnl:   ts.length ? Math.round(ts.reduce((s, t) => s + t.pnl, 0) / ts.length) : 0,
    };
  }).filter(b => b.trades > 0);
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = avg(x.slice(0, n)), my = avg(y.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ex = x[i] - mx, ey = y[i] - my;
    num += ex * ey; dx += ex * ex; dy += ey * ey;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function formatPnl(v: number): string {
  return v >= 0 ? `+${Math.round(v).toLocaleString()}` : Math.round(v).toLocaleString();
}

function downsample<T>(arr: T[], maxLen: number): T[] {
  if (arr.length <= maxLen) return arr;
  const step = arr.length / maxLen;
  return Array.from({ length: maxLen }, (_, i) => arr[Math.floor(i * step)]);
}
