import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler, validateBody } from '../middleware';
import { listTemplates, buildConfigFromTemplate, TemplateKey } from '../../services/strategyTemplates';
import { calculateMargin, tradeLegsToMarginPositions } from '../../services/marginCalculator';
import { Instrument } from '../../types';

const router = Router();

// ─── GET /strategy/templates ──────────────────────────────────────────────────

router.get('/templates',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(listTemplates());
  }),
);

// ─── GET /strategy/templates/:key ─────────────────────────────────────────────

router.get('/templates/:key',
  asyncHandler(async (req: Request, res: Response) => {
    const templates = listTemplates();
    const t = templates.find(x => x.key === req.params.key);
    if (!t) return res.status(404).json({ code: 'NOT_FOUND', message: 'Template not found' });
    res.json(t);
  }),
);

// ─── POST /strategy/from-template — build config from template ────────────────

const FromTemplateSchema = z.object({
  templateKey: z.string(),
  instrument:  z.enum(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX', 'SENSEX']),
  startDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  capital:     z.number().positive(),
  lotSize:     z.number().int().positive(),
  name:        z.string().optional(),
  entryTime:   z.string().optional(),
  exitTime:    z.string().optional(),
});

router.post('/from-template',
  validateBody(FromTemplateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { templateKey, ...rest } = req.body;
    const config = buildConfigFromTemplate(templateKey as TemplateKey, rest);
    res.json(config);
  }),
);

// ─── POST /strategy/calculate-margin ─────────────────────────────────────────

const MarginRequestSchema = z.object({
  CalculateForExpiryDay: z.boolean().default(false),
  IndexPrices: z.record(z.number()),
  ListOfPosition: z.array(z.object({
    Expiry:         z.string(),
    InstrumentType: z.enum(['CE', 'PE']),
    NetQty:         z.number().int(),
    Strike:         z.number().positive(),
    Ticker:         z.enum(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX', 'SENSEX']),
    Premium:        z.number().optional(),
  })),
});

router.post('/calculate-margin',
  validateBody(MarginRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { CalculateForExpiryDay, IndexPrices, ListOfPosition } = req.body;
    const result = calculateMargin(ListOfPosition, IndexPrices as any, CalculateForExpiryDay);
    res.json(result);
  }),
);

export default router;
