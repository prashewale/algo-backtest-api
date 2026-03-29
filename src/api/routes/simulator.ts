import { Router, Request, Response } from 'express';
import { asyncHandler, validateBody } from '../middleware';
import {
  CreateSimulatorSessionSchema, AdvanceCandlesSchema,
  JumpToCandleSchema, OpenPositionSchema, ClosePositionSchema,
} from '../middleware/validation';
import {
  createSession, getSession, deleteSession,
  getCurrentCandleData, advanceCandles, jumpToCandle,
  openPosition, closePosition, getMarketSnapshot,
} from '../../core/simulator/simulator';
import { getAvailableDays } from '../../services/dataService';
import { Instrument } from '../../types';

const router = Router();

// ─── POST /simulator/sessions — start a new session ──────────────────────────

router.post('/sessions',
  validateBody(CreateSimulatorSessionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { instrument, startCandle, initialCapital } = req.body;
    const session = await createSession(instrument, startCandle, initialCapital);
    res.status(201).json(session);
  }),
);

// ─── GET /simulator/sessions/:id — get session state ─────────────────────────

router.get('/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const session = await getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ code: 'NOT_FOUND', message: 'Session not found' });
    res.json(session);
  }),
);

// ─── DELETE /simulator/sessions/:id ──────────────────────────────────────────

router.delete('/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    await deleteSession(req.params.sessionId);
    res.json({ message: 'Session deleted' });
  }),
);

// ─── GET /simulator/sessions/:id/market — current candle market snapshot ─────

router.get('/sessions/:sessionId/market',
  asyncHandler(async (req: Request, res: Response) => {
    const snapshot = await getMarketSnapshot(req.params.sessionId);
    if (!snapshot) return res.status(404).json({ code: 'NOT_FOUND', message: 'No candle data at current position' });
    res.json(snapshot);
  }),
);

// ─── GET /simulator/sessions/:id/candle — full candle + positions PnL ────────

router.get('/sessions/:sessionId/candle',
  asyncHandler(async (req: Request, res: Response) => {
    const data = await getCurrentCandleData(req.params.sessionId);
    if (!data) return res.status(404).json({ code: 'NOT_FOUND', message: 'No candle data' });
    res.json(data);
  }),
);

// ─── POST /simulator/sessions/:id/advance — step forward ─────────────────────

router.post('/sessions/:sessionId/advance',
  validateBody(AdvanceCandlesSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { steps } = req.body;
    const session = await advanceCandles(req.params.sessionId, steps);
    if (!session) return res.status(410).json({ code: 'END_OF_DATA', message: 'No more candles available' });
    res.json(session);
  }),
);

// ─── POST /simulator/sessions/:id/jump — jump to datetime ────────────────────

router.post('/sessions/:sessionId/jump',
  validateBody(JumpToCandleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const session = await jumpToCandle(req.params.sessionId, req.body.candleDatetime);
    if (!session) return res.status(404).json({ code: 'NOT_FOUND', message: 'Candle not found' });
    res.json(session);
  }),
);

// ─── POST /simulator/sessions/:id/positions — open a position ────────────────

router.post('/sessions/:sessionId/positions',
  validateBody(OpenPositionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { session, position } = await openPosition(req.params.sessionId, req.body);
    res.status(201).json({ session, position });
  }),
);

// ─── DELETE /simulator/sessions/:id/positions/:posId — close position ────────

router.delete('/sessions/:sessionId/positions/:positionId',
  validateBody(ClosePositionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { session, pnl } = await closePosition(
      req.params.sessionId,
      req.params.positionId,
      req.body.lots,
    );
    res.json({ session, pnl });
  }),
);

// ─── GET /simulator/available-days — calendar for instrument+year ─────────────

router.get('/available-days',
  asyncHandler(async (req: Request, res: Response) => {
    const instrument = req.query.instrument as Instrument;
    const year = parseInt(req.query.year as string);
    if (!instrument || !year) return res.status(400).json({ code: 'BAD_REQUEST', message: 'instrument and year required' });
    const days = await getAvailableDays(instrument, year);
    res.json({ instrument, year, days, count: days.length });
  }),
);

export default router;
