/**
 * Margin calculation service.
 * Implements simplified SEBI SPAN methodology for NSE options.
 * Mirrors the CalculateMarginRequest / CalculatedMarginResponse types from the frontend.
 */

import { Instrument, OptionType } from '../types';

// ─── Types mirroring the shared types ────────────────────────────────────────

export interface MarginPosition {
  Expiry: string;
  InstrumentType: 'CE' | 'PE';
  NetQty: number;       // positive = long, negative = short
  Strike: number;
  Ticker: Instrument;
  Premium?: number;     // current price
}

export interface MarginResult {
  FinalExposure: number;
  FinalSpan: number;
  MarginBenefit: number;
  TotalMargin: number;
  IndividualPositionsMargin: PositionMargin[];
}

export interface PositionMargin {
  Expiry: string;
  InstrumentType: 'CE' | 'PE';
  Exposure: number;
  NetQty: number;
  Premium: number;
  Span: number;
  Strike: number;
  Ticker: Instrument;
}

// ─── SPAN parameters per instrument ──────────────────────────────────────────
// Approximate values — in production connect to NSE SPAN calculator API

const SPAN_PARAMS: Record<Instrument, {
  lotSize: number;
  scanRange: number;        // % of underlying price
  exposureMarginPct: number;
  shortOptionMinimumCharge: number;
}> = {
  NIFTY:      { lotSize: 50,  scanRange: 0.035, exposureMarginPct: 0.03,  shortOptionMinimumCharge: 0.0075 },
  BANKNIFTY:  { lotSize: 15,  scanRange: 0.04,  exposureMarginPct: 0.035, shortOptionMinimumCharge: 0.0075 },
  FINNIFTY:   { lotSize: 40,  scanRange: 0.04,  exposureMarginPct: 0.03,  shortOptionMinimumCharge: 0.0075 },
  MIDCPNIFTY: { lotSize: 75,  scanRange: 0.045, exposureMarginPct: 0.03,  shortOptionMinimumCharge: 0.0075 },
  BANKEX:     { lotSize: 15,  scanRange: 0.04,  exposureMarginPct: 0.035, shortOptionMinimumCharge: 0.0075 },
  SENSEX:     { lotSize: 10,  scanRange: 0.035, exposureMarginPct: 0.03,  shortOptionMinimumCharge: 0.0075 },
};

// ─── Main calculator ──────────────────────────────────────────────────────────

export function calculateMargin(
  positions: MarginPosition[],
  indexPrices: Record<Instrument, number>,
  forExpiryDay: boolean = false,
): MarginResult {
  const positionsMargin: PositionMargin[] = [];
  let totalSpan = 0;
  let totalExposure = 0;
  let marginBenefit = 0;

  // Group positions by instrument for hedge benefit calculation
  const byInstrument = groupBy(positions, p => p.Ticker);

  for (const [ticker, instPositions] of Object.entries(byInstrument)) {
    const params   = SPAN_PARAMS[ticker as Instrument];
    const spotPrice = indexPrices[ticker as Instrument] ?? 20000;

    // Calculate raw margin per position
    const instMargins = instPositions.map(pos => {
      const premium = pos.Premium ?? 0;
      const absQty  = Math.abs(pos.NetQty);
      const lotSize = params.lotSize;
      const notional = spotPrice * absQty * lotSize;

      // SPAN: scan range × notional for short options
      let span = 0;
      if (pos.NetQty < 0) {
        // Short option — SPAN = max(scan range × notional, SOMC × notional)
        const scanMargin = params.scanRange * notional;
        const somc       = params.shortOptionMinimumCharge * notional;
        span = Math.max(scanMargin, somc);
        // On expiry day, double the SPAN for short positions
        if (forExpiryDay) span *= 1.5;
      } else {
        // Long option — capped at premium paid
        span = premium * absQty * lotSize;
      }

      // Exposure margin for short positions
      const exposure = pos.NetQty < 0
        ? params.exposureMarginPct * notional
        : 0;

      return {
        Expiry:         pos.Expiry,
        InstrumentType: pos.InstrumentType,
        Exposure:       Math.round(exposure),
        NetQty:         pos.NetQty,
        Premium:        premium,
        Span:           Math.round(span),
        Strike:         pos.Strike,
        Ticker:         pos.Ticker,
      } satisfies PositionMargin;
    });

    positionsMargin.push(...instMargins);

    // Hedge benefit — reduce SPAN for hedged portfolios
    // Simple implementation: if both calls and puts exist, reduce by 10–20%
    const benefit = computeHedgeBenefit(instMargins, instPositions, spotPrice);
    marginBenefit += benefit;

    totalSpan     += instMargins.reduce((s, m) => s + m.Span, 0);
    totalExposure += instMargins.reduce((s, m) => s + m.Exposure, 0);
  }

  const finalSpan     = Math.max(0, totalSpan - marginBenefit);
  const finalExposure = totalExposure;

  return {
    FinalSpan:     Math.round(finalSpan),
    FinalExposure: Math.round(finalExposure),
    MarginBenefit: Math.round(marginBenefit),
    TotalMargin:   Math.round(finalSpan + finalExposure),
    IndividualPositionsMargin: positionsMargin,
  };
}

function computeHedgeBenefit(
  margins: PositionMargin[],
  positions: MarginPosition[],
  spot: number,
): number {
  const shorts = positions.filter(p => p.NetQty < 0);
  const longs  = positions.filter(p => p.NetQty > 0);
  if (!shorts.length || !longs.length) return 0;

  // Bull spread: short CE + long CE same expiry = 20% benefit
  // Bear spread: short PE + long PE same expiry = 20% benefit
  // Iron condor:  2 spreads = 30% benefit
  let benefit = 0;

  const shortsByExpiry = groupBy(shorts, p => p.Expiry);
  const longsByExpiry  = groupBy(longs,  p => p.Expiry);

  for (const [expiry, shortPos] of Object.entries(shortsByExpiry)) {
    const longPos = longsByExpiry[expiry];
    if (!longPos?.length) continue;

    const shortCE = shortPos.filter(p => p.InstrumentType === 'CE');
    const shortPE = shortPos.filter(p => p.InstrumentType === 'PE');
    const longCE  = longPos.filter(p => p.InstrumentType === 'CE');
    const longPE  = longPos.filter(p => p.InstrumentType === 'PE');

    const hasCallSpread = shortCE.length > 0 && longCE.length > 0;
    const hasPutSpread  = shortPE.length > 0 && longPE.length > 0;

    const spreadMargin = margins
      .filter(m => m.Expiry === expiry)
      .reduce((s, m) => s + m.Span, 0);

    if (hasCallSpread && hasPutSpread) {
      benefit += spreadMargin * 0.30; // Iron condor = 30% benefit
    } else if (hasCallSpread || hasPutSpread) {
      benefit += spreadMargin * 0.20; // Single spread = 20% benefit
    }
  }

  return benefit;
}

// ─── Position-to-trade conversion ────────────────────────────────────────────

export function tradeLegsToMarginPositions(
  legs: {
    strike: number;
    optionType: 'CE' | 'PE';
    action: 'BUY' | 'SELL';
    lots: number;
    lotSize: number;
    expiry: string;
    entryPrice: number;
  }[],
  ticker: Instrument,
): MarginPosition[] {
  return legs.map(leg => ({
    Ticker:         ticker,
    Strike:         leg.strike,
    InstrumentType: leg.optionType,
    NetQty:         leg.action === 'BUY' ? leg.lots : -leg.lots,
    Expiry:         leg.expiry,
    Premium:        leg.entryPrice,
  }));
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item);
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}
