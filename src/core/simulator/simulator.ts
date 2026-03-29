import { v4 as uuidv4 } from 'uuid';
import {
  SimulatorSession, SimulatorPosition, SimulatorTrade,
  Instrument, OptionType, TradeAction,
} from '../../types';
import { fetchCandleAt, fetchNextCandles, processCandle } from '../../services/dataService';
import { SimulatorSessionModel } from '../../models';
import logger from '../../utils/logger';

// ─── Session management ───────────────────────────────────────────────────────

export async function createSession(
  instrument: Instrument,
  startCandle: string,
  initialCapital: number,
): Promise<SimulatorSession> {
  const sessionId = uuidv4();
  const session: SimulatorSession = {
    sessionId,
    instrument,
    currentCandle: startCandle,
    speed: 1,
    isPlaying: false,
    positions: [],
    cashBalance: initialCapital,
    totalPnl: 0,
    trade_log: [],
  };
  await SimulatorSessionModel.create(session);
  logger.info(`Simulator session created: ${sessionId}`);
  return session;
}

export async function getSession(sessionId: string): Promise<SimulatorSession | null> {
  return SimulatorSessionModel.findOne({ sessionId }).lean();
}

export async function deleteSession(sessionId: string): Promise<void> {
  await SimulatorSessionModel.deleteOne({ sessionId });
}

// ─── Candle navigation ────────────────────────────────────────────────────────

/**
 * Get the current candle's full market data for the session.
 */
export async function getCurrentCandleData(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const raw = await fetchCandleAt(session.instrument, session.currentCandle);
  if (!raw) return null;

  const processed = processCandle(raw);
  const pnl = computeSessionPnl(session, processed);

  return {
    candle: raw,
    processed,
    session: {
      ...session,
      totalPnl: pnl.total,
      positions: session.positions.map(p => ({
        ...p,
        currentPrice: pnl.byPosition[p.id]?.currentPrice ?? p.entryPrice,
        unrealizedPnl: pnl.byPosition[p.id]?.unrealizedPnl ?? 0,
      })),
    },
  };
}

/**
 * Advance the session by N candles.
 */
export async function advanceCandles(sessionId: string, steps: number = 1): Promise<SimulatorSession | null> {
  const session = await SimulatorSessionModel.findOne({ sessionId });
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const nextDocs = await fetchNextCandles(session.instrument as Instrument, session.currentCandle, steps);
  if (!nextDocs.length) return null; // end of data

  const lastDoc = nextDocs[nextDocs.length - 1];
  session.currentCandle = lastDoc.candle;
  await session.save();
  return session.toObject();
}

/**
 * Jump to a specific candle datetime.
 */
export async function jumpToCandle(sessionId: string, candleDatetime: string): Promise<SimulatorSession | null> {
  const session = await SimulatorSessionModel.findOne({ sessionId });
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const raw = await fetchCandleAt(session.instrument as Instrument, candleDatetime);
  if (!raw) throw new Error(`No candle found at ${candleDatetime}`);

  session.currentCandle = candleDatetime;
  await session.save();
  return session.toObject();
}

// ─── Position management ──────────────────────────────────────────────────────

export interface OpenPositionRequest {
  expiry: string;
  strike: number;
  optionType: OptionType;
  action: TradeAction;
  lots: number;
  lotSize: number;
}

export async function openPosition(
  sessionId: string,
  req: OpenPositionRequest,
): Promise<{ session: SimulatorSession; position: SimulatorPosition }> {
  const session = await SimulatorSessionModel.findOne({ sessionId });
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const raw = await fetchCandleAt(session.instrument as Instrument, session.currentCandle);
  if (!raw) throw new Error('No candle data at current position');

  const processed = processCandle(raw);

  // Find the current price for this option
  const price = findOptionPrice(processed, req.expiry, req.strike, req.optionType);
  if (price === null) throw new Error(`No price found for ${req.strike} ${req.optionType} exp ${req.expiry}`);

  const cost = req.action === 'BUY' ? price * req.lots * req.lotSize : 0;
  if (req.action === 'BUY' && session.cashBalance < cost) {
    throw new Error(`Insufficient balance: need ₹${cost.toFixed(2)}, have ₹${session.cashBalance.toFixed(2)}`);
  }

  const positionId = uuidv4();
  const position: SimulatorPosition = {
    id: positionId,
    expiry: req.expiry,
    strike: req.strike,
    optionType: req.optionType,
    action: req.action,
    lots: req.lots,
    lotSize: req.lotSize,
    entryPrice: price,
    entryCandle: session.currentCandle,
  };

  const tradeLog: SimulatorTrade = {
    id: uuidv4(),
    type: 'open',
    positionId,
    expiry: req.expiry,
    strike: req.strike,
    optionType: req.optionType,
    action: req.action,
    lots: req.lots,
    price,
    candle: session.currentCandle,
  };

  session.positions.push(position);
  session.trade_log.push(tradeLog);
  if (req.action === 'BUY') session.cashBalance -= cost;

  await session.save();
  logger.info(`Position opened: ${req.action} ${req.lots}x ${req.strike}${req.optionType} @ ₹${price}`);
  return { session: session.toObject(), position };
}

export async function closePosition(
  sessionId: string,
  positionId: string,
  lots?: number, // partial close if specified
): Promise<{ session: SimulatorSession; pnl: number }> {
  const session = await SimulatorSessionModel.findOne({ sessionId });
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const posIdx = session.positions.findIndex(p => p.id === positionId);
  if (posIdx === -1) throw new Error(`Position ${positionId} not found`);

  const pos = session.positions[posIdx];
  const raw = await fetchCandleAt(session.instrument as Instrument, session.currentCandle);
  if (!raw) throw new Error('No candle data at current position');

  const processed = processCandle(raw);
  const currentPrice = findOptionPrice(processed, pos.expiry, pos.strike, pos.optionType);
  if (currentPrice === null) throw new Error('Cannot find current price — option may have expired');

  const closeLots = lots ?? pos.lots;
  const mult = pos.action === 'SELL' ? -1 : 1;
  const pnl = mult * (currentPrice - pos.entryPrice) * closeLots * pos.lotSize;

  const tradeLog: SimulatorTrade = {
    id: uuidv4(),
    type: 'close',
    positionId,
    expiry: pos.expiry,
    strike: pos.strike,
    optionType: pos.optionType,
    action: pos.action === 'BUY' ? 'SELL' : 'BUY',
    lots: closeLots,
    price: currentPrice,
    candle: session.currentCandle,
    pnl,
  };

  session.trade_log.push(tradeLog);
  session.cashBalance += (pos.action === 'BUY' ? currentPrice * closeLots * pos.lotSize : 0) + pnl;
  session.totalPnl += pnl;

  if (closeLots >= pos.lots) {
    session.positions.splice(posIdx, 1);
  } else {
    session.positions[posIdx].lots -= closeLots;
  }

  await session.save();
  logger.info(`Position closed: ₹${pnl.toFixed(2)} PnL`);
  return { session: session.toObject(), pnl };
}

// ─── PnL computation ──────────────────────────────────────────────────────────

function computeSessionPnl(
  session: SimulatorSession,
  candle: ReturnType<typeof processCandle>,
): { total: number; byPosition: Record<string, { currentPrice: number; unrealizedPnl: number }> } {
  let total = 0;
  const byPosition: Record<string, { currentPrice: number; unrealizedPnl: number }> = {};

  for (const pos of session.positions) {
    const currentPrice = findOptionPrice(candle, pos.expiry, pos.strike, pos.optionType);
    if (currentPrice === null) continue;
    const mult = pos.action === 'SELL' ? -1 : 1;
    const unrealizedPnl = mult * (currentPrice - pos.entryPrice) * pos.lots * pos.lotSize;
    byPosition[pos.id] = { currentPrice, unrealizedPnl };
    total += unrealizedPnl;
  }
  return { total, byPosition };
}

function findOptionPrice(
  candle: ReturnType<typeof processCandle>,
  expiry: string,
  strike: number,
  optionType: OptionType,
): number | null {
  for (const exp of candle.expiries) {
    if (exp.expiry !== expiry) continue;
    for (const s of exp.strikes) {
      if (s.strike !== strike) continue;
      const greek = optionType === 'CE' ? s.call : s.put;
      return greek?.close ?? null;
    }
  }
  return null;
}

// ─── Market snapshot for UI ───────────────────────────────────────────────────

export async function getMarketSnapshot(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const raw = await fetchCandleAt(session.instrument as Instrument, session.currentCandle);
  if (!raw) return null;

  const processed = processCandle(raw);
  const nearestExpiry = processed.expiries[0];

  return {
    candle: session.currentCandle,
    spot: processed.spotPrice,
    vix: processed.vix,
    futures: processed.futures,
    impliedFutures: processed.impliedFutures,
    nearestExpiry: nearestExpiry ? {
      expiry: nearestExpiry.expiry,
      daysToExpiry: nearestExpiry.daysToExpiry,
      atmStrike: nearestExpiry.atmStrike,
      straddlePremium: nearestExpiry.straddlePremium,
      pcr: nearestExpiry.pcr,
      maxPain: nearestExpiry.maxPainStrike,
      ivSkew: nearestExpiry.ivSkew,
      // Option chain table rows (ATM ± 10 strikes)
      chain: nearestExpiry.strikes.slice(
        Math.max(0, nearestExpiry.atmIndex - 10),
        nearestExpiry.atmIndex + 11,
      ),
    } : null,
    allExpiries: processed.expiries.map(e => ({
      expiry: e.expiry,
      daysToExpiry: e.daysToExpiry,
      atmStrike: e.atmStrike,
      straddlePremium: e.straddlePremium,
    })),
  };
}
