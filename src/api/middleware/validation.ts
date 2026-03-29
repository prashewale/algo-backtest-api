import { z } from 'zod';

// ─── Primitives ───────────────────────────────────────────────────────────────

const InstrumentSchema = z.enum(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX', 'SENSEX']);
const DateStringSchema  = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
const TimeStringSchema  = z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM');
const OptionTypeSchema  = z.enum(['CE', 'PE']);
const TradeActionSchema = z.enum(['BUY', 'SELL']);

// ─── Strike selection ─────────────────────────────────────────────────────────

const StrikeSelectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('atm_offset'), offset: z.number().int().min(-20).max(20) }),
  z.object({ type: z.literal('delta'),      targetDelta: z.number().min(-1).max(1) }),
  z.object({ type: z.literal('fixed_strike'), strike: z.number().positive() }),
  z.object({ type: z.literal('pct_otm'),    pct: z.number().min(0).max(20) }),
]);

// ─── Expiry selection ─────────────────────────────────────────────────────────

const ExpirySelectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('nearest') }),
  z.object({ type: z.literal('weekly'),  weekOffset:  z.number().int().min(0).max(4) }),
  z.object({ type: z.literal('monthly'), monthOffset: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal('fixed_expiry'), date: DateStringSchema }),
]);

// ─── Strategy leg ─────────────────────────────────────────────────────────────

export const StrategyLegSchema = z.object({
  id: z.string().uuid(),
  action: TradeActionSchema,
  optionType: OptionTypeSchema,
  strikeSelection: StrikeSelectionSchema,
  expirySelection: ExpirySelectionSchema,
  lots: z.number().int().positive().max(100),
});

// ─── Condition node / group (recursive) ──────────────────────────────────────

const ConditionOperatorSchema = z.enum([
  'crosses_above','crosses_below','gt','gte','lt','lte','eq','neq',
  'pct_change_gt','pct_change_lt','is_between','before','after',
]);

const RhsTypeSchema = z.enum([
  'value','field','pct_of_field','field_plus','field_minus','field_mult',
]);

const ConditionNodeSchema = z.object({
  id: z.string(),
  type: z.literal('condition'),
  field: z.string().min(1),
  operator: ConditionOperatorSchema,
  rhsType: RhsTypeSchema,
  rhsValue: z.number().optional(),
  rhsField: z.string().optional(),
  rhsFrom: z.number().optional(),
  rhsTo: z.number().optional(),
  lookback: z.number().int().positive().optional(),
  lookbackUnit: z.enum(['candles','minutes','days']).optional(),
  strikeContext: z.union([
    z.enum(['atm','atm+1','atm-1']),
    z.object({ fixed: z.number() }),
    z.object({ delta: z.number() }),
  ]).optional(),
  expiryContext: z.union([
    z.enum(['nearest','weekly','monthly']),
    z.object({ fixed: z.string() }),
  ]).optional(),
});

// Recursive condition group (lazy because of self-reference)
type ConditionGroupInput = {
  id: string;
  type: 'group';
  logic: 'AND' | 'OR' | 'NOT';
  children: (z.infer<typeof ConditionNodeSchema> | ConditionGroupInput)[];
};

const ConditionGroupSchema: z.ZodType<ConditionGroupInput> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.literal('group'),
    logic: z.enum(['AND', 'OR', 'NOT']),
    children: z.array(z.union([ConditionNodeSchema, ConditionGroupSchema])).min(1),
  })
);

const ConditionTreeSchema = z.union([ConditionNodeSchema, ConditionGroupSchema]);

// ─── Strategy conditions ──────────────────────────────────────────────────────

const StrategyConditionsSchema = z.object({
  entry:        ConditionTreeSchema.optional(),
  exit:         ConditionTreeSchema.optional(),
  stopLoss:     ConditionTreeSchema.optional(),
  target:       ConditionTreeSchema.optional(),
  trailingStop: ConditionTreeSchema.optional(),
  reEntry:      ConditionTreeSchema.optional(),
  positionSize: ConditionTreeSchema.optional(),
  hedge:        ConditionTreeSchema.optional(),
  alert:        ConditionTreeSchema.optional(),
}).default({});

// ─── Risk rules ───────────────────────────────────────────────────────────────

export const RiskRulesSchema = z.object({
  stopLossPct:      z.number().positive().max(100).optional(),
  targetPct:        z.number().positive().max(500).optional(),
  maxDailyLossPct:  z.number().positive().max(100).optional(),
  trailingStop: z.object({
    enabled:  z.boolean(),
    trailPct: z.number().positive().max(100),
  }).optional(),
  reEntry: z.object({
    enabled:  z.boolean(),
    maxCount: z.number().int().positive().max(10),
  }).optional(),
  ivFilter: z.object({
    enabled: z.boolean(),
    minIV:   z.number().min(0).max(200),
    maxIV:   z.number().min(0).max(200),
  }).optional(),
  vixFilter: z.object({
    enabled: z.boolean(),
    maxVix:  z.number().min(0).max(100),
  }).optional(),
}).default({});

// ─── Backtest config ──────────────────────────────────────────────────────────

export const BacktestConfigSchema = z.object({
  name: z.string().min(1).max(100),
  instrument: InstrumentSchema,
  startDate: DateStringSchema,
  endDate: DateStringSchema,
  entryTime: TimeStringSchema,
  exitTime: TimeStringSchema,
  capital: z.number().positive().max(100_000_000),
  lotSize: z.number().int().positive().max(10_000),
  legs: z.array(StrategyLegSchema).min(1).max(10),
  conditions: StrategyConditionsSchema,
  riskRules: RiskRulesSchema,
}).refine(d => d.startDate < d.endDate, { message: 'startDate must be before endDate' })
  .refine(d => d.entryTime < d.exitTime, { message: 'entryTime must be before exitTime' });

export const CreateBacktestSchema = z.object({
  config: BacktestConfigSchema,
  priority: z.enum(['low','normal','high']).default('normal'),
});

// ─── Simulator schemas ────────────────────────────────────────────────────────

export const CreateSimulatorSessionSchema = z.object({
  instrument: InstrumentSchema,
  startCandle: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
  initialCapital: z.number().positive().default(500_000),
});

export const AdvanceCandlesSchema = z.object({
  steps: z.number().int().positive().max(390).default(1),
});

export const JumpToCandleSchema = z.object({
  candleDatetime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
});

export const OpenPositionSchema = z.object({
  expiry: DateStringSchema,
  strike: z.number().positive(),
  optionType: OptionTypeSchema,
  action: TradeActionSchema,
  lots: z.number().int().positive().max(100),
  lotSize: z.number().int().positive().max(10_000),
});

export const ClosePositionSchema = z.object({
  lots: z.number().int().positive().optional(),
});

// ─── Query schemas ────────────────────────────────────────────────────────────

export const BacktestListQuerySchema = z.object({
  page:       z.coerce.number().int().positive().default(1),
  pageSize:   z.coerce.number().int().positive().max(100).default(20),
  status:     z.enum(['queued','running','completed','failed']).optional(),
  instrument: InstrumentSchema.optional(),
});

export const CandleQuerySchema = z.object({
  instrument: InstrumentSchema,
  date:       DateStringSchema,
  year:       z.coerce.number().int().min(2020).max(2030).optional(),
});

export const AvailableDaysQuerySchema = z.object({
  instrument: InstrumentSchema,
  year:       z.coerce.number().int().min(2020).max(2030),
});

export type CreateBacktestInput    = z.infer<typeof CreateBacktestSchema>;
export type CreateSessionInput     = z.infer<typeof CreateSimulatorSessionSchema>;
export type OpenPositionInput      = z.infer<typeof OpenPositionSchema>;
export type BacktestListQueryInput = z.infer<typeof BacktestListQuerySchema>;
