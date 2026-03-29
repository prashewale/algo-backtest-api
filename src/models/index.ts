import mongoose, { Schema, Document, Model, Connection } from 'mongoose';
import { RawOptionChainDocument, BacktestJob, SimulatorSession, getCollectionName, Instrument } from '../types';
import logger from '../utils/logger';

// ─── Connection ───────────────────────────────────────────────────────────────

let connection: Connection | null = null;

export async function connectMongo(uri: string): Promise<void> {
  if (connection) return;
  await mongoose.connect(uri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  connection = mongoose.connection;
  logger.info('MongoDB connected');

  connection.on('error', (err) => logger.error('MongoDB error', { err }));
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
  connection = null;
}

// ─── Option Chain Schema (dynamic — one per instrument+year collection) ────────

const GreekSnapshotSchema = {
  timestamp: { type: String, default: null },
  close: { type: Number, default: null },
};

const OptionExpirySchema = new Schema({
  strike: [Number],
  call_close: [{ type: Number, default: null }],
  call_open_interest: [{ type: Number, default: null }],
  call_implied_vol: [{ type: Number, default: null }],
  call_delta: [{ type: Number, default: null }],
  call_gamma: [{ type: Number, default: null }],
  call_theta: [{ type: Number, default: null }],
  call_vega: [{ type: Number, default: null }],
  call_rho: [{ type: Number, default: null }],
  call_timestamp: [{ type: String, default: null }],
  put_close: [{ type: Number, default: null }],
  put_open_interest: [{ type: Number, default: null }],
  put_implied_vol: [{ type: Number, default: null }],
  put_delta: [{ type: Number, default: null }],
  put_gamma: [{ type: Number, default: null }],
  put_theta: [{ type: Number, default: null }],
  put_vega: [{ type: Number, default: null }],
  put_rho: [{ type: Number, default: null }],
  put_timestamp: [{ type: String, default: null }],
}, { _id: false });

const OptionChainSchema = new Schema<RawOptionChainDocument>({
  candle: { type: String, required: true, index: true },
  underlying: { type: String, required: true, index: true },
  cash: {
    timestamp: String,
    close: Number,
  },
  futures: { type: Map, of: new Schema({ timestamp: String, close: Number }, { _id: false }) },
  implied_futures: { type: Map, of: Number },
  options: { type: Map, of: OptionExpirySchema },
  vix: {
    timestamp: String,
    close: Number,
  },
  perpetual_future: { type: Number, default: null },
}, {
  timestamps: false,
  versionKey: false,
});

// Compound index for time-range queries
OptionChainSchema.index({ candle: 1, underlying: 1 });
// Index for date-range backtesting (candle is ISO string so lexicographic sort works)
OptionChainSchema.index({ candle: 1 });

// Cache of dynamically created models (one per collection)
const optionChainModelCache = new Map<string, Model<RawOptionChainDocument>>();

export function getOptionChainModel(instrument: Instrument, year: number): Model<RawOptionChainDocument> {
  const collectionName = getCollectionName(instrument, year);
  if (optionChainModelCache.has(collectionName)) {
    return optionChainModelCache.get(collectionName)!;
  }
  // Use existing model if already compiled (hot-reload safety)
  let model: Model<RawOptionChainDocument>;
  try {
    model = mongoose.model<RawOptionChainDocument>(collectionName);
  } catch {
    model = mongoose.model<RawOptionChainDocument>(collectionName, OptionChainSchema, collectionName);
  }
  optionChainModelCache.set(collectionName, model);
  return model;
}

// ─── BacktestJob Schema ───────────────────────────────────────────────────────

export interface BacktestJobDocument extends Omit<BacktestJob, '_id'>, Document {}

const BacktestJobSchema = new Schema<BacktestJobDocument>({
  jobId: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
  config: { type: Schema.Types.Mixed, required: true },
  progress: { type: Number, default: 0 },
  startedAt: Date,
  completedAt: Date,
  error: String,
  result: { type: Schema.Types.Mixed },
}, {
  timestamps: true,
  versionKey: false,
});

BacktestJobSchema.index({ status: 1, createdAt: -1 });
BacktestJobSchema.index({ 'config.instrument': 1, status: 1 });

export const BacktestJobModel = mongoose.model<BacktestJobDocument>('BacktestJob', BacktestJobSchema, 'backtest_jobs');

// ─── SimulatorSession Schema ──────────────────────────────────────────────────

export interface SimulatorSessionDocument extends Omit<SimulatorSession, '_id'>, Document {}

const SimulatorSessionSchema = new Schema<SimulatorSessionDocument>({
  sessionId: { type: String, required: true, unique: true, index: true },
  instrument: { type: String, required: true },
  currentCandle: { type: String, required: true },
  speed: { type: Number, default: 1 },
  isPlaying: { type: Boolean, default: false },
  positions: [{ type: Schema.Types.Mixed }],
  cashBalance: { type: Number, required: true },
  totalPnl: { type: Number, default: 0 },
  trade_log: [{ type: Schema.Types.Mixed }],
}, {
  timestamps: true,
  versionKey: false,
});

// TTL — auto-delete sessions after 24 hours of inactivity
SimulatorSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

export const SimulatorSessionModel = mongoose.model<SimulatorSessionDocument>('SimulatorSession', SimulatorSessionSchema, 'simulator_sessions');
