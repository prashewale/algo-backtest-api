import { getOptionChainModel } from "../models";
import {
  RawOptionChainDocument,
  ProcessedCandle,
  ProcessedExpiry,
  ProcessedStrike,
  GreekSnapshot,
  Instrument,
  RawOptionExpiry,
} from "../types";
import { differenceInDays, parseISO } from "date-fns";
import logger from "../utils/logger";

// ─── Collection routing ────────────────────────────────────────────────────────

/**
 * Get all year collections needed for a date range.
 * e.g. 2023-11-01 to 2024-03-31 → [2023, 2024]
 */
export function getYearsForRange(startDate: string, endDate: string): number[] {
  const startYear = new Date(startDate).getFullYear();
  const endYear = new Date(endDate).getFullYear();
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);
  return years;
}

// ─── Raw data fetching ────────────────────────────────────────────────────────

/**
 * Fetch raw candles for a date range, routing across year collections.
 * Returns documents sorted ascending by candle datetime.
 */
export async function fetchRawCandles(
  instrument: Instrument,
  startDate: string,
  endDate: string,
  entryTime: string = "09:15",
  exitTime: string = "15:30",
): Promise<RawOptionChainDocument[]> {
  const years = getYearsForRange(startDate, endDate);
  const results: RawOptionChainDocument[] = [];

  for (const year of years) {
    const model = getOptionChainModel(instrument, year);

    // Build candle time filter — candle is stored as ISO string "2024-01-01T09:16:00"
    const yearStart =
      year === new Date(startDate).getFullYear() ? startDate : `${year}-01-01`;
    const yearEnd =
      year === new Date(endDate).getFullYear() ? endDate : `${year}-12-31`;

    const docs = await model
      .find({
        candle: {
          $gte: `${yearStart}T${entryTime}:00`,
          $lte: `${yearEnd}T${exitTime}:00`,
        },
      })
      .lean()
      .sort({ candle: 1 });

    results.push(...(docs as unknown as RawOptionChainDocument[]));
  }

  logger.debug(
    `Fetched ${results.length} candles for ${instrument} ${startDate}→${endDate}`,
  );
  return results;
}

/**
 * Fetch a single candle by exact timestamp.
 */
export async function fetchCandleAt(
  instrument: Instrument,
  candleDatetime: string,
): Promise<RawOptionChainDocument | null> {
  const year = new Date(candleDatetime).getFullYear();
  const model = getOptionChainModel(instrument, year);
  return model
    .findOne({ candle: candleDatetime })
    .lean() as Promise<RawOptionChainDocument | null>;
}

/**
 * Fetch the next N candles after a given datetime.
 */
export async function fetchNextCandles(
  instrument: Instrument,
  afterDatetime: string,
  count: number = 1,
): Promise<RawOptionChainDocument[]> {
  const year = new Date(afterDatetime).getFullYear();
  const nextYear = year + 1;
  const model = getOptionChainModel(instrument, year);
  let docs = (await model
    .find({ candle: { $gt: afterDatetime } })
    .lean()
    .sort({ candle: 1 })
    .limit(count)) as unknown as RawOptionChainDocument[];

  // If we need candles that span into next year
  if (docs.length < count) {
    try {
      const nextModel = getOptionChainModel(instrument, nextYear);
      const more = (await nextModel
        .find({})
        .lean()
        .sort({ candle: 1 })
        .limit(count - docs.length)) as unknown as RawOptionChainDocument[];
      docs = [...docs, ...more];
    } catch {
      /* next year collection may not exist */
    }
  }
  return docs;
}

/**
 * Get distinct trading days available for an instrument+year.
 */
export async function getAvailableDays(
  instrument: Instrument,
  year: number,
): Promise<string[]> {
  const model = getOptionChainModel(instrument, year);
  const result = await model.aggregate([
    { $group: { _id: { $substr: ["$candle", 0, 10] } } },
    { $sort: { _id: 1 } },
  ]);
  return result.map((r: any) => r._id);
}

/**
 * Get all available expiry dates in a candle's option chain.
 */
export function getExpiriesFromDoc(doc: RawOptionChainDocument): string[] {
  return Object.keys(doc.options || {}).sort();
}

// ─── Candle processing ────────────────────────────────────────────────────────

/**
 * Transform raw MongoDB document into a rich ProcessedCandle with
 * computed metrics: ATM strike, straddle premium, PCR, max pain, IV skew.
 */
export function processCandle(doc: RawOptionChainDocument): ProcessedCandle {
  const spot = doc.cash?.close ?? 0;
  const vix = doc.vix?.close ?? 0;
  const candleDate = parseISO(doc.candle);

  const expiries: ProcessedExpiry[] = [];

  for (const [expiryDate, rawExpiry] of Object.entries(doc.options || {})) {
    const impliedFut =
      (doc.implied_futures as Record<string, number>)?.[expiryDate] ?? spot;
    const expiry = processExpiry(
      expiryDate,
      rawExpiry,
      spot,
      candleDate,
      impliedFut,
    );
    if (expiry) expiries.push(expiry);
  }

  // Sort expiries by date ascending
  expiries.sort((a, b) => a.expiry.localeCompare(b.expiry));

  return {
    candle: candleDate,
    underlying: doc.underlying,
    spotPrice: spot,
    vix,
    expiries,
    futures: Object.fromEntries(
      Object.entries(doc.futures || {}).map(([k, v]) => [k, v.close]),
    ),
    impliedFutures: doc.implied_futures as Record<string, number>,
  };
}

function processExpiry(
  expiryDate: string,
  raw: RawOptionExpiry,
  spot: number,
  candleDate: Date,
  impliedFuture: number,
): ProcessedExpiry | null {
  if (!raw.strike?.length) return null;

  const expiryDt = parseISO(expiryDate);
  const daysToExpiry = Math.max(0, differenceInDays(expiryDt, candleDate));

  // Find ATM strike (closest to spot)
  let atmIndex = 0;
  let minDiff = Infinity;
  for (let i = 0; i < raw.strike.length; i++) {
    const diff = Math.abs(raw.strike[i] - spot);
    if (diff < minDiff) {
      minDiff = diff;
      atmIndex = i;
    }
  }
  const atmStrike = raw.strike[atmIndex];

  // Build strike array
  const strikes: ProcessedStrike[] = raw.strike.map((strike, i) => {
    const pctFromAtm = spot > 0 ? ((strike - atmStrike) / atmStrike) * 100 : 0;
    const absPct = Math.abs(pctFromAtm);
    const moneyness =
      absPct < 0.1
        ? "atm"
        : pctFromAtm > 3
          ? "deep_otm"
          : pctFromAtm > 0
            ? "otm"
            : pctFromAtm < -3
              ? "deep_itm"
              : "itm";

    const call: GreekSnapshot | null =
      raw.call_close[i] != null
        ? {
            close: raw.call_close[i]!,
            openInterest: raw.call_open_interest?.[i] ?? null,
            impliedVol: raw.call_implied_vol?.[i] ?? null,
            delta: raw.call_delta?.[i] ?? null,
            gamma: raw.call_gamma?.[i] ?? null,
            theta: raw.call_theta?.[i] ?? null,
            vega: raw.call_vega?.[i] ?? null,
            rho: raw.call_rho?.[i] ?? null,
            timestamp: raw.call_timestamp?.[i] ?? null,
          }
        : null;

    const put: GreekSnapshot | null =
      raw.put_close[i] != null
        ? {
            close: raw.put_close[i]!,
            openInterest: raw.put_open_interest?.[i] ?? null,
            impliedVol: raw.put_implied_vol?.[i] ?? null,
            delta: raw.put_delta?.[i] ?? null,
            gamma: raw.put_gamma?.[i] ?? null,
            theta: raw.put_theta?.[i] ?? null,
            vega: raw.put_vega?.[i] ?? null,
            rho: raw.put_rho?.[i] ?? null,
            timestamp: raw.put_timestamp?.[i] ?? null,
          }
        : null;

    return { strike, moneyness, strikePctFromAtm: pctFromAtm, call, put };
  });

  // Straddle premium (ATM call + ATM put)
  const atmCall = strikes[atmIndex]?.call?.close ?? 0;
  const atmPut = strikes[atmIndex]?.put?.close ?? 0;
  const straddlePremium = atmCall + atmPut;

  // PCR by OI
  const totalCallOI =
    raw.call_open_interest?.reduce((s, v) => (s ?? 0) + (v ?? 0), 0) ?? 0;
  const totalPutOI =
    raw.put_open_interest?.reduce((s, v) => (s ?? 0) + (v ?? 0), 0) ?? 0;
  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

  // Max pain — strike where total option writer profit is maximized
  const maxPainStrike = computeMaxPain(raw);

  // IV skew at ATM
  const atmCallIV = strikes[atmIndex]?.call?.impliedVol ?? 0;
  const atmPutIV = strikes[atmIndex]?.put?.impliedVol ?? 0;
  const ivSkew = atmCallIV - atmPutIV;

  return {
    expiry: expiryDate,
    daysToExpiry,
    impliedFuture,
    strikes,
    atmStrike,
    atmIndex,
    straddlePremium,
    pcr,
    maxPainStrike,
    ivSkew,
  };
}

function computeMaxPain(raw: RawOptionExpiry): number {
  let maxPainStrike = raw.strike[0] ?? 0;
  let minLoss = Infinity;

  for (const targetStrike of raw.strike) {
    let totalLoss = 0;
    for (let i = 0; i < raw.strike.length; i++) {
      const s = raw.strike[i];
      if (s == null) continue;
      const callOI = raw.call_open_interest?.[i] ?? 0;
      const putOI = raw.put_open_interest?.[i] ?? 0;
      // Call writer loss at target
      if (targetStrike > s && callOI) totalLoss += (targetStrike - s) * callOI;
      // Put writer loss at target
      if (targetStrike < s && putOI) totalLoss += (s - targetStrike) * putOI;
    }
    if (totalLoss < minLoss) {
      minLoss = totalLoss;
      maxPainStrike = targetStrike;
    }
  }
  return maxPainStrike;
}

// ─── Strike selector ──────────────────────────────────────────────────────────

export function selectStrike(
  expiry: ProcessedExpiry,
  selection: import("../types").StrikeSelection,
  optionType: import("../types").OptionType,
): ProcessedStrike | null {
  const { strikes, atmIndex } = expiry;

  switch (selection.type) {
    case "atm_offset": {
      const idx = atmIndex + selection.offset;
      return strikes[Math.max(0, Math.min(idx, strikes.length - 1))] ?? null;
    }
    case "delta": {
      const targetDelta = Math.abs(selection.targetDelta);
      let best: ProcessedStrike | null = null;
      let bestDiff = Infinity;
      for (const s of strikes) {
        const greek = optionType === "CE" ? s.call : s.put;
        if (!greek?.delta) continue;
        const diff = Math.abs(Math.abs(greek.delta) - targetDelta);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = s;
        }
      }
      return best;
    }
    case "fixed_strike":
      return strikes.find((s) => s.strike === selection.strike) ?? null;
    case "pct_otm": {
      const spot = expiry.impliedFuture;
      const targetStrike =
        optionType === "CE"
          ? spot * (1 + selection.pct / 100)
          : spot * (1 - selection.pct / 100);
      let best: ProcessedStrike | null = null;
      let bestDiff = Infinity;
      for (const s of strikes) {
        const diff = Math.abs(s.strike - targetStrike);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = s;
        }
      }
      return best;
    }
    default:
      return null;
  }
}

/**
 * Select the best expiry for a given ExpirySelection from available expiries.
 */
export function selectExpiry(
  expiries: ProcessedExpiry[],
  selection: import("../types").ExpirySelection,
  candleDate: Date,
): ProcessedExpiry | null {
  const active = expiries.filter((e) => e.daysToExpiry >= 0);
  if (!active.length) return null;

  switch (selection.type) {
    case "nearest":
      return active[0] ?? null;
    case "weekly":
      return active[Math.min(selection.weekOffset, active.length - 1)] ?? null;
    case "monthly": {
      // Find expiry closest to end of month
      const monthly = active.filter((e) => {
        const d = parseISO(e.expiry);
        return d.getDate() >= 25;
      });
      return (
        monthly[Math.min(selection.monthOffset, monthly.length - 1)] ??
        active[0] ??
        null
      );
    }
    case "fixed_expiry":
      return active.find((e) => e.expiry === selection.date) ?? null;
    default:
      return null;
  }
}
