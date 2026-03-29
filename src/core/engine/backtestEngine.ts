import {
  BacktestConfig, BacktestResult, BacktestSummary,
  TradeRecord, TradeRecordLeg, EquityPoint, MonthlyPnl,
  GreeksTimelinePoint, ConditionStats, ProcessedCandle,
  StrategyLeg, ProcessedExpiry, ProcessedStrike, GreekSnapshot,
} from '../../types';
import { fetchRawCandles, processCandle, selectExpiry, selectStrike } from '../../services/dataService';
import { evaluateConditionTree, EvalContext, resolveField } from '../conditions/evaluator';
import logger from '../../utils/logger';

// ─── Position tracking ────────────────────────────────────────────────────────

interface OpenPosition {
  tradeId: number;
  entryCandle: string;
  entryTime: string;
  legs: OpenLeg[];
  entryConditionSnapshot: Record<string, number>;
  trailingHighPnl: number;    // for trailing stop
  reEntryCount: number;
}

interface OpenLeg {
  legId: string;
  action: 'BUY' | 'SELL';
  optionType: 'CE' | 'PE';
  expiry: string;
  strike: number;
  entryPrice: number;
  lots: number;
  greeksAtEntry: Partial<GreekSnapshot>;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export async function runBacktestEngine(
  config: BacktestConfig,
  onProgress?: (pct: number) => void,
): Promise<BacktestResult> {
  logger.info(`Starting backtest: ${config.name} [${config.instrument} ${config.startDate}→${config.endDate}]`);

  // 1. Load raw candles from MongoDB
  const rawCandles = await fetchRawCandles(
    config.instrument,
    config.startDate,
    config.endDate,
    config.entryTime,
    config.exitTime,
  );

  if (!rawCandles.length) {
    throw new Error(`No data found for ${config.instrument} in range ${config.startDate}→${config.endDate}`);
  }

  // 2. Process all candles
  const candles = rawCandles.map(processCandle);
  const total = candles.length;

  // 3. Build day-grouped map for entry/exit logic
  const dayGroups = groupByDay(candles);
  const tradingDays = Object.keys(dayGroups).sort();

  // State
  let equity = config.capital;
  let maxEquity = config.capital;
  let maxDrawdown = 0;
  let maxDrawdownDuration = 0;
  let drawdownStart: number | null = null;

  const equityCurve: EquityPoint[] = [{ date: config.startDate, value: config.capital, drawdown: 0 }];
  const allTrades: TradeRecord[] = [];
  const monthlyPnlMap: Record<string, { pnl: number; trades: number; wins: number }> = {};
  const greeksTimeline: GreeksTimelinePoint[] = [];

  let tradeIdCounter = 1;
  let openPosition: OpenPosition | null = null;
  let candleIdx = 0;
  let dailyLoss = 0;
  let lastDayStr = '';

  const condStats: ConditionStats = {
    entryConditionFired: 0, entryConditionSkipped: 0,
    exitConditionFired: 0, slConditionFired: 0,
    targetConditionFired: 0, alertsFired: 0,
  };

  // 4. Iterate trading days
  for (let di = 0; di < tradingDays.length; di++) {
    const dayStr = tradingDays[di];
    const dayCandleList = dayGroups[dayStr];
    dailyLoss = 0;

    for (let ci = 0; ci < dayCandleList.length; ci++) {
      const current = dayCandleList[ci];
      const previous = ci > 0 ? dayCandleList[ci - 1] : (di > 0 ? dayGroups[tradingDays[di - 1]]?.at(-1) : undefined);
      const history  = collectHistory(dayGroups, tradingDays, di, ci, 20);
      const ctx: EvalContext = { current, previous, history };

      const timeStr = formatTime(current.candle);
      candleIdx++;

      // Progress callback every 2%
      if (onProgress && candleIdx % Math.max(1, Math.floor(total / 50)) === 0) {
        onProgress(Math.round((candleIdx / total) * 100));
      }

      // Greeks snapshot (every 15 min)
      if (ci % 15 === 0) {
        const snap = buildGreeksSnapshot(current);
        if (snap) greeksTimeline.push(snap);
      }

      // ── Daily loss reset ──
      if (dayStr !== lastDayStr) { dailyLoss = 0; lastDayStr = dayStr; }

      // ── Check if we have an open position ──
      if (openPosition) {
        const unrealizedPnl = computeUnrealizedPnl(openPosition, current, config.lotSize);

        // Exit time
        if (timeStr >= config.exitTime) {
          const trade = closePosition(openPosition, current, config.lotSize, 'eod', tradeIdCounter++);
          equity += trade.pnl;
          allTrades.push(trade);
          openPosition = null;
          recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
          continue;
        }

        // Max daily loss
        if (config.riskRules.maxDailyLossPct && dailyLoss <= -(config.capital * config.riskRules.maxDailyLossPct / 100)) {
          const trade = closePosition(openPosition, current, config.lotSize, 'stop_loss', tradeIdCounter++);
          equity += trade.pnl;
          allTrades.push(trade);
          openPosition = null;
          recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
          continue;
        }

        // Condition-based SL
        if (config.conditions.stopLoss && evaluateConditionTree(config.conditions.stopLoss, ctx)) {
          condStats.slConditionFired++;
          const trade = closePosition(openPosition, current, config.lotSize, 'stop_loss', tradeIdCounter++);
          equity += trade.pnl; dailyLoss += trade.pnl;
          allTrades.push(trade);
          openPosition = null;
          recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
          continue;
        }

        // Condition-based Target
        if (config.conditions.target && evaluateConditionTree(config.conditions.target, ctx)) {
          condStats.targetConditionFired++;
          const trade = closePosition(openPosition, current, config.lotSize, 'target', tradeIdCounter++);
          equity += trade.pnl; dailyLoss += trade.pnl;
          allTrades.push(trade);
          openPosition = null;
          recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
          continue;
        }

        // Pct-based SL
        if (config.riskRules.stopLossPct) {
          const slThreshold = -Math.abs(config.riskRules.stopLossPct / 100 * openPosition.legs.reduce((s, l) => s + l.entryPrice * l.lots * config.lotSize, 0));
          if (unrealizedPnl <= slThreshold) {
            const trade = closePosition(openPosition, current, config.lotSize, 'stop_loss', tradeIdCounter++);
            equity += trade.pnl; dailyLoss += trade.pnl;
            allTrades.push(trade);
            openPosition = null;
            recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
            continue;
          }
        }

        // Pct-based Target
        if (config.riskRules.targetPct) {
          const tgtThreshold = Math.abs(config.riskRules.targetPct / 100 * openPosition.legs.reduce((s, l) => s + l.entryPrice * l.lots * config.lotSize, 0));
          if (unrealizedPnl >= tgtThreshold) {
            const trade = closePosition(openPosition, current, config.lotSize, 'target', tradeIdCounter++);
            equity += trade.pnl; dailyLoss += trade.pnl;
            allTrades.push(trade);
            openPosition = null;
            recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
            continue;
          }
        }

        // Trailing stop
        if (config.riskRules.trailingStop?.enabled) {
          if (unrealizedPnl > openPosition.trailingHighPnl) openPosition.trailingHighPnl = unrealizedPnl;
          const trailThreshold = openPosition.trailingHighPnl * (1 - config.riskRules.trailingStop.trailPct / 100);
          if (unrealizedPnl < trailThreshold && openPosition.trailingHighPnl > 0) {
            const trade = closePosition(openPosition, current, config.lotSize, 'stop_loss', tradeIdCounter++);
            equity += trade.pnl; dailyLoss += trade.pnl;
            allTrades.push(trade);
            openPosition = null;
            recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
            continue;
          }
        }

        // Condition-based exit
        if (config.conditions.exit && evaluateConditionTree(config.conditions.exit, ctx)) {
          condStats.exitConditionFired++;
          const trade = closePosition(openPosition, current, config.lotSize, 'condition_exit', tradeIdCounter++);
          equity += trade.pnl; dailyLoss += trade.pnl;
          allTrades.push(trade);
          openPosition = null;
          recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
          continue;
        }

        // Alert condition
        if (config.conditions.alert && evaluateConditionTree(config.conditions.alert, ctx)) {
          condStats.alertsFired++;
        }

      } else {
        // ── Try to open a position ──

        // Entry time check
        if (timeStr < config.entryTime || timeStr >= config.exitTime) continue;

        // IV filter
        if (config.riskRules.ivFilter?.enabled) {
          const iv = resolveField('iv_avg', current) ?? 0;
          if (iv < config.riskRules.ivFilter.minIV / 100 || iv > config.riskRules.ivFilter.maxIV / 100) continue;
        }

        // VIX filter
        if (config.riskRules.vixFilter?.enabled && current.vix > config.riskRules.vixFilter.maxVix) continue;

        // Evaluate entry condition
        const entryFires = evaluateConditionTree(config.conditions.entry, ctx);
        if (!entryFires) {
          condStats.entryConditionSkipped++;
          continue;
        }
        condStats.entryConditionFired++;

        // Build position legs
        const legs = buildLegs(config.legs, current, config.lotSize);
        if (!legs.length) continue;

        openPosition = {
          tradeId: tradeIdCounter,
          entryCandle: current.candle.toISOString(),
          entryTime: timeStr,
          legs,
          entryConditionSnapshot: buildConditionSnapshot(current),
          trailingHighPnl: 0,
          reEntryCount: 0,
        };
      }

      // Equity curve update (end of each candle, if position open)
      if (openPosition) {
        const unrealized = computeUnrealizedPnl(openPosition, current, config.lotSize);
        const curEquity = equity + unrealized;
        if (curEquity > maxEquity) { maxEquity = curEquity; drawdownStart = null; }
        const dd = maxEquity > 0 ? ((maxEquity - curEquity) / maxEquity) * 100 : 0;
        if (dd > maxDrawdown) { maxDrawdown = dd; }
        if (dd > 0 && drawdownStart === null) drawdownStart = candleIdx;
        equityCurve.push({ date: current.candle.toISOString().slice(0, 10), value: Math.round(curEquity), drawdown: dd });
      }
    }

    // EOD: force close if still open
    if (openPosition) {
      const lastCandle = dayCandleList.at(-1);
      if (lastCandle) {
        const trade = closePosition(openPosition, lastCandle, config.lotSize, 'eod', tradeIdCounter++);
        equity += trade.pnl;
        allTrades.push(trade);
        openPosition = null;
        recordMonthly(monthlyPnlMap, dayStr, trade.pnl);
      }
    }

    equityCurve.push({ date: dayStr, value: Math.round(equity), drawdown: maxEquity > 0 ? ((maxEquity - equity) / maxEquity) * 100 : 0 });
    if (onProgress) onProgress(Math.round((di / tradingDays.length) * 100));
  }

  const summary = computeSummary(allTrades, config.capital, equity, maxDrawdown, maxDrawdownDuration, equityCurve);
  const monthlyPnl: MonthlyPnl[] = Object.entries(monthlyPnlMap).map(([month, v]) => ({
    month,
    pnl: Math.round(v.pnl),
    trades: v.trades,
    winRate: v.trades > 0 ? Math.round((v.wins / v.trades) * 100) : 0,
  })).sort((a, b) => a.month.localeCompare(b.month));

  logger.info(`Backtest complete: ${allTrades.length} trades, equity ${config.capital} → ${Math.round(equity)}`);

  return { summary, equityCurve, trades: allTrades, monthlyPnl, greeksTimeline, conditionStats: condStats };
}

// ─── Leg builder ──────────────────────────────────────────────────────────────

function buildLegs(legConfigs: StrategyLeg[], candle: ProcessedCandle, lotSize: number): OpenLeg[] {
  const result: OpenLeg[] = [];
  for (const legCfg of legConfigs) {
    const expiry = selectExpiry(candle.expiries, legCfg.expirySelection, candle.candle);
    if (!expiry) continue;
    const strikeObj = selectStrike(expiry, legCfg.strikeSelection, legCfg.optionType);
    if (!strikeObj) continue;
    const greek = legCfg.optionType === 'CE' ? strikeObj.call : strikeObj.put;
    if (!greek?.close) continue;

    result.push({
      legId: legCfg.id,
      action: legCfg.action,
      optionType: legCfg.optionType,
      expiry: expiry.expiry,
      strike: strikeObj.strike,
      entryPrice: greek.close,
      lots: legCfg.lots,
      greeksAtEntry: { ...greek },
    });
  }
  return result;
}

// ─── Position close ───────────────────────────────────────────────────────────

function closePosition(
  pos: OpenPosition,
  candle: ProcessedCandle,
  lotSize: number,
  reason: TradeRecord['exitReason'],
  tradeId: number,
): TradeRecord {
  let totalPnl = 0;
  const closedLegs: TradeRecordLeg[] = [];
  let totalDelta = 0, totalGamma = 0, totalTheta = 0, totalVega = 0;
  let totalMargin = 0;

  for (const leg of pos.legs) {
    const exitPrice = getCurrentPrice(leg, candle) ?? leg.entryPrice;
    const multiplier = leg.action === 'SELL' ? -1 : 1;
    const legPnl = multiplier * (exitPrice - leg.entryPrice) * leg.lots * lotSize;
    totalPnl += legPnl;
    totalMargin += leg.entryPrice * leg.lots * lotSize * 0.1; // rough 10% margin proxy

    const g = leg.greeksAtEntry;
    const sign = leg.action === 'SELL' ? -1 : 1;
    totalDelta += (g.delta ?? 0) * sign * leg.lots * lotSize;
    totalGamma += (g.gamma ?? 0) * sign * leg.lots * lotSize;
    totalTheta += (g.theta ?? 0) * sign * leg.lots * lotSize;
    totalVega  += (g.vega  ?? 0) * sign * leg.lots * lotSize;

    closedLegs.push({
      legId: leg.legId,
      action: leg.action,
      optionType: leg.optionType,
      expiry: leg.expiry,
      strike: leg.strike,
      entryPrice: leg.entryPrice,
      exitPrice,
      lots: leg.lots,
      pnl: Math.round(legPnl),
      greeksAtEntry: leg.greeksAtEntry,
    });
  }

  return {
    id: tradeId,
    entryCandle: pos.entryCandle,
    exitCandle: candle.candle.toISOString(),
    legs: closedLegs,
    entryTime: pos.entryTime,
    exitTime: formatTime(candle.candle),
    pnl: Math.round(totalPnl),
    status: totalPnl > 0 ? 'WIN' : totalPnl < 0 ? 'LOSS' : 'BREAKEVEN',
    exitReason: reason,
    marginUsed: Math.round(totalMargin),
    netGreeks: { delta: totalDelta, gamma: totalGamma, theta: totalTheta, vega: totalVega },
    entryConditionSnapshot: pos.entryConditionSnapshot,
  };
}

function getCurrentPrice(leg: OpenLeg, candle: ProcessedCandle): number | null {
  for (const expiry of candle.expiries) {
    if (expiry.expiry !== leg.expiry) continue;
    for (const s of expiry.strikes) {
      if (s.strike !== leg.strike) continue;
      const greek = leg.optionType === 'CE' ? s.call : s.put;
      return greek?.close ?? null;
    }
  }
  return null;
}

function computeUnrealizedPnl(pos: OpenPosition, candle: ProcessedCandle, lotSize: number): number {
  let total = 0;
  for (const leg of pos.legs) {
    const current = getCurrentPrice(leg, candle) ?? leg.entryPrice;
    const mult = leg.action === 'SELL' ? -1 : 1;
    total += mult * (current - leg.entryPrice) * leg.lots * lotSize;
  }
  return total;
}

// ─── Summary computation ──────────────────────────────────────────────────────

function computeSummary(
  trades: TradeRecord[],
  initialCapital: number,
  finalEquity: number,
  maxDrawdown: number,
  maxDrawdownDuration: number,
  equityCurve: EquityPoint[],
): BacktestSummary {
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;

  const tradingDays = new Set(equityCurve.map(e => e.date)).size;
  const cagr = tradingDays > 0 ? (Math.pow(finalEquity / initialCapital, 252 / tradingDays) - 1) * 100 : 0;

  // Sharpe / Sortino from equity curve returns
  const returns = equityCurve.slice(1).map((e, i) =>
    equityCurve[i].value > 0 ? (e.value - equityCurve[i].value) / equityCurve[i].value : 0
  ).filter(r => !isNaN(r));

  const avgR  = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const std   = stdDev(returns);
  const downR = returns.filter(r => r < 0);
  const downStd = stdDev(downR);
  const ann   = Math.sqrt(252);

  const sharpe  = std  > 0 ? (avgR / std)  * ann : 0;
  const sortino = downStd > 0 ? (avgR / downStd) * ann : 0;
  const calmar  = maxDrawdown > 0 ? cagr / maxDrawdown : 0;

  const avgWin  = wins.length  ? wins.reduce((s, t)  => s + t.pnl, 0) / wins.length  : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const profitFactor = losses.length && avgLoss !== 0
    ? Math.abs((avgWin * wins.length) / (avgLoss * losses.length))
    : 0;

  // Consecutive wins/losses
  let maxConsecWins = 0, maxConsecLosses = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curW++; curL = 0; if (curW > maxConsecWins) maxConsecWins = curW; }
    else           { curL++; curW = 0; if (curL > maxConsecLosses) maxConsecLosses = curL; }
  }

  return {
    totalReturn:  +totalReturn.toFixed(2),
    cagr:         +cagr.toFixed(2),
    sharpe:       +sharpe.toFixed(2),
    sortino:      +sortino.toFixed(2),
    calmar:       +calmar.toFixed(2),
    maxDrawdown:  +maxDrawdown.toFixed(2),
    maxDrawdownDuration,
    winRate:      trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    profitFactor: +profitFactor.toFixed(2),
    totalTrades:  trades.length,
    wins:         wins.length,
    losses:       losses.length,
    avgWin:       Math.round(avgWin),
    avgLoss:      Math.round(avgLoss),
    netPnl:       Math.round(netPnl),
    finalEquity:  Math.round(finalEquity),
    avgMarginUsed: trades.length ? Math.round(trades.reduce((s, t) => s + t.marginUsed, 0) / trades.length) : 0,
    maxConsecutiveWins:   maxConsecWins,
    maxConsecutiveLosses: maxConsecLosses,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupByDay(candles: ProcessedCandle[]): Record<string, ProcessedCandle[]> {
  const map: Record<string, ProcessedCandle[]> = {};
  for (const c of candles) {
    const day = c.candle.toISOString().slice(0, 10);
    if (!map[day]) map[day] = [];
    map[day].push(c);
  }
  return map;
}

function collectHistory(
  dayGroups: Record<string, ProcessedCandle[]>,
  tradingDays: string[],
  di: number,
  ci: number,
  maxN: number,
): ProcessedCandle[] {
  const result: ProcessedCandle[] = [];
  // Current day up to ci
  result.push(...(dayGroups[tradingDays[di]]?.slice(0, ci) ?? []));
  // Previous days
  let d = di - 1;
  while (result.length < maxN && d >= 0) {
    const prev = dayGroups[tradingDays[d]] ?? [];
    result.unshift(...prev);
    d--;
  }
  return result.slice(-maxN);
}

function formatTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function buildGreeksSnapshot(candle: ProcessedCandle): GreeksTimelinePoint | null {
  const expiry = candle.expiries[0];
  if (!expiry) return null;
  const atm = expiry.strikes[expiry.atmIndex];
  return {
    date: candle.candle.toISOString().slice(0, 10),
    iv:    atm?.call?.impliedVol ?? atm?.put?.impliedVol ?? 0,
    delta: atm?.call?.delta ?? 0,
    theta: atm?.call?.theta ?? 0,
    vega:  atm?.call?.vega ?? 0,
    vix:   candle.vix,
    spotPrice: candle.spotPrice,
  };
}

function buildConditionSnapshot(candle: ProcessedCandle): Record<string, number> {
  const snap: Record<string, number> = {};
  snap['cash.close'] = candle.spotPrice;
  snap['vix.close']  = candle.vix;
  const exp = candle.expiries[0];
  if (exp) {
    snap['straddle_premium'] = exp.straddlePremium;
    snap['pcr_oi'] = exp.pcr;
    snap['atm_strike'] = exp.atmStrike;
    snap['dte'] = exp.daysToExpiry;
    const atm = exp.strikes[exp.atmIndex];
    if (atm?.call) { snap['call.delta'] = atm.call.delta ?? 0; snap['call.iv'] = atm.call.impliedVol ?? 0; }
    if (atm?.put)  { snap['put.delta']  = atm.put.delta  ?? 0; snap['put.iv']  = atm.put.impliedVol  ?? 0; }
  }
  return snap;
}

function recordMonthly(
  map: Record<string, { pnl: number; trades: number; wins: number }>,
  dayStr: string,
  pnl: number,
) {
  const month = dayStr.slice(0, 7);
  if (!map[month]) map[month] = { pnl: 0, trades: 0, wins: 0 };
  map[month].pnl    += pnl;
  map[month].trades += 1;
  if (pnl > 0) map[month].wins += 1;
}

function stdDev(arr: number[]): number {
  if (!arr.length) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}
