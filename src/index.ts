import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import { connectMongo } from './models';
import { startBacktestWorker, backtestQueue } from './workers/backtestWorker';
import { errorHandler, notFoundHandler, requestTimer } from './api/middleware';
import { WebSocketGateway } from './gateway/websocket';
import { getRedisClient, disconnectRedis } from './cache/redis';

import backtestRoutes  from './api/routes/backtest';
import simulatorRoutes from './api/routes/simulator';
import marketRoutes    from './api/routes/market';
import strategyRoutes  from './api/routes/strategy';
import analyticsRoutes from './api/routes/analytics';
import { createBullBoardRouter } from './api/routes/bullBoard';
import logger from './utils/logger';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// ─── Core middleware ──────────────────────────────────────────────────────────

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(compression() as any);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('short', { stream: { write: (msg) => logger.http(msg.trim()) } }));
app.use(requestTimer);

// ─── Rate limiting ────────────────────────────────────────────────────────────

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX || '100'),
  message:  { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/backtests', backtestRoutes);
app.use('/api/simulator', simulatorRoutes);
app.use('/api/market',    marketRoutes);
app.use('/api/strategy',  strategyRoutes);
app.use('/api/analytics', analyticsRoutes);

// Bull Board queue dashboard (dev/staging only)
if (process.env.NODE_ENV !== 'production' || process.env.BULL_BOARD === '1') {
  app.use('/admin/queues', createBullBoardRouter());
  logger.info('Bull Board available at /admin/queues');
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  try {
    const [queueStats] = await Promise.all([
      backtestQueue.getJobCounts(),
    ]);
    res.json({
      status: 'ok',
      version: process.env.npm_package_version ?? '1.0.0',
      uptime: Math.round(process.uptime()),
      queue: queueStats,
    });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});

// ─── API index ────────────────────────────────────────────────────────────────

app.get('/api', (_req, res) => {
  res.json({
    version: '1.0.0',
    endpoints: {
      'POST   /api/backtests':                       'Create & queue a backtest',
      'GET    /api/backtests':                        'List backtests (paginated)',
      'GET    /api/backtests/:jobId':                 'Get job status & result',
      'GET    /api/backtests/:jobId/result':          'Get result only',
      'GET    /api/backtests/:jobId/trades':          'Paginated trade log',
      'DELETE /api/backtests/:jobId':                 'Cancel or delete',
      'GET    /api/backtests/queue':                  'Queue stats',
      'POST   /api/simulator/sessions':              'Start simulator session',
      'GET    /api/simulator/sessions/:id':           'Get session state',
      'GET    /api/simulator/sessions/:id/market':    'Market snapshot at current candle',
      'GET    /api/simulator/sessions/:id/candle':    'Full candle + PnL',
      'POST   /api/simulator/sessions/:id/advance':   'Advance N candles',
      'POST   /api/simulator/sessions/:id/jump':      'Jump to datetime',
      'POST   /api/simulator/sessions/:id/positions': 'Open position',
      'DELETE /api/simulator/sessions/:id/positions/:posId': 'Close position',
      'GET    /api/market/chain':                     'Option chain at candle',
      'GET    /api/market/candle':                    'Single candle data',
      'GET    /api/market/candles':                   'Batch candles (max 31 days)',
      'GET    /api/market/available-days':            'Trading calendar',
      'GET    /api/market/expiries':                  'Expiry dates on a date',
      'GET    /api/market/stats':                     'Collection stats',
    },
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

app.use(notFoundHandler);
app.use(errorHandler);

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    await connectMongo(process.env.MONGODB_URI!);
    // Connect Redis (non-fatal — queue still works via Bull's own connection)
    try { getRedisClient(); } catch { logger.warn('Redis unavailable — caching disabled'); }

    startBacktestWorker();

    const server = app.listen(PORT, () => {
      logger.info(`🚀 API server running on http://localhost:${PORT}`);
      logger.info(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`   MongoDB: ${process.env.MONGODB_URI}`);
      logger.info(`   Redis:   ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
    });

    // WebSocket gateway on the same HTTP server
    const wsGateway = new WebSocketGateway(server);
    logger.info(`   WebSocket: ws://localhost:${PORT}/ws`);

    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received — shutting down');
      await wsGateway.close();
      await backtestQueue.close();
      await disconnectRedis();
      server.close(() => process.exit(0));
    });

  } catch (err) {
    logger.error('Boot failed', { err });
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
});

boot();

export default app;
