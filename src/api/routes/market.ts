import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware';
import { fetchCandleAt, fetchRawCandles, getAvailableDays, processCandle } from '../../services/dataService';
import { getOptionChainModel } from '../../models';
import { Instrument, INSTRUMENTS } from '../../types';

const router = Router();

// ─── GET /market/instruments ──────────────────────────────────────────────────

router.get('/instruments',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ instruments: INSTRUMENTS });
  }),
);

// ─── GET /market/candle — single candle by datetime ──────────────────────────

router.get('/candle',
  asyncHandler(async (req: Request, res: Response) => {
    const instrument = req.query.instrument as Instrument;
    const datetime   = req.query.datetime as string;
    if (!instrument || !datetime) return res.status(400).json({ code: 'BAD_REQUEST', message: 'instrument and datetime required' });

    const raw = await fetchCandleAt(instrument, datetime);
    if (!raw) return res.status(404).json({ code: 'NOT_FOUND', message: `No candle at ${datetime}` });

    const include = req.query.include as string;
    if (include === 'processed') {
      return res.json({ raw, processed: processCandle(raw) });
    }
    res.json(raw);
  }),
);

// ─── GET /market/chain — option chain for a candle ───────────────────────────

router.get('/chain',
  asyncHandler(async (req: Request, res: Response) => {
    const instrument = req.query.instrument as Instrument;
    const datetime   = req.query.datetime as string;
    const expiry     = req.query.expiry as string | undefined;

    if (!instrument || !datetime) return res.status(400).json({ code: 'BAD_REQUEST', message: 'instrument and datetime required' });

    const raw = await fetchCandleAt(instrument, datetime);
    if (!raw) return res.status(404).json({ code: 'NOT_FOUND', message: 'Candle not found' });

    const processed = processCandle(raw);

    // Filter to specific expiry if requested
    const expiries = expiry
      ? processed.expiries.filter(e => e.expiry === expiry)
      : processed.expiries;

    res.json({
      candle: datetime,
      spot: processed.spotPrice,
      vix: processed.vix,
      expiries,
    });
  }),
);

// ─── GET /market/available-days ───────────────────────────────────────────────

router.get('/available-days',
  asyncHandler(async (req: Request, res: Response) => {
    const instrument = req.query.instrument as Instrument;
    const year       = parseInt(req.query.year as string);
    if (!instrument || !year) return res.status(400).json({ code: 'BAD_REQUEST', message: 'instrument and year required' });

    const days = await getAvailableDays(instrument, year);
    res.json({ instrument, year, days, count: days.length });
  }),
);

// ─── GET /market/candles — batch candles for a date range ────────────────────

router.get('/candles',
  asyncHandler(async (req: Request, res: Response) => {
    const instrument  = req.query.instrument as Instrument;
    const startDate   = req.query.startDate as string;
    const endDate     = req.query.endDate as string;
    const entryTime   = (req.query.entryTime as string) || '09:15';
    const exitTime    = (req.query.exitTime  as string) || '15:30';
    const processed   = req.query.processed === 'true';

    if (!instrument || !startDate || !endDate) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'instrument, startDate, endDate required' });
    }

    // Safety limit
    const start = new Date(startDate), end = new Date(endDate);
    const dayDiff = (end.getTime() - start.getTime()) / 86400000;
    if (dayDiff > 31) return res.status(400).json({ code: 'RANGE_TOO_LARGE', message: 'Max 31 days per request' });

    const raws = await fetchRawCandles(instrument, startDate, endDate, entryTime, exitTime);

    if (processed) {
      return res.json({
        count: raws.length,
        candles: raws.map(r => processCandle(r)),
      });
    }

    res.json({ count: raws.length, candles: raws });
  }),
);

// ─── GET /market/expiries — expiry dates for an instrument ───────────────────

router.get('/expiries',
  asyncHandler(async (req: Request, res: Response) => {
    const instrument = req.query.instrument as Instrument;
    const date       = req.query.date as string;       // "2024-01-01"
    if (!instrument || !date) return res.status(400).json({ code: 'BAD_REQUEST', message: 'instrument and date required' });

    // Find candle near market open for that date
    const datetime = `${date}T09:16:00`;
    const raw = await fetchCandleAt(instrument, datetime);
    if (!raw) return res.status(404).json({ code: 'NOT_FOUND', message: 'No data for this date' });

    const expiries = Object.keys(raw.options ?? {}).sort();
    const impliedFutures = raw.implied_futures ?? {};
    res.json({
      date,
      expiries: expiries.map(e => ({
        expiry: e,
        impliedFuture: (impliedFutures as any)[e] ?? null,
        daysToExpiry: Math.ceil((new Date(e).getTime() - new Date(date).getTime()) / 86400000),
      })),
    });
  }),
);

// ─── GET /market/stats — collection stats ────────────────────────────────────

router.get('/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const instrument = req.query.instrument as Instrument;
    const year       = parseInt(req.query.year as string);
    if (!instrument || !year) return res.status(400).json({ code: 'BAD_REQUEST', message: 'instrument and year required' });

    const model = getOptionChainModel(instrument, year);
    const [count, sample] = await Promise.all([
      model.countDocuments(),
      model.findOne().sort({ candle: 1 }).lean(),
    ]);
    const last = await model.findOne().sort({ candle: -1 }).lean();

    res.json({
      instrument, year,
      collection: `option_chain_${instrument.toLowerCase()}_${year}`,
      totalCandles: count,
      earliestCandle: (sample as any)?.candle ?? null,
      latestCandle:   (last as any)?.candle ?? null,
    });
  }),
);

export default router;
