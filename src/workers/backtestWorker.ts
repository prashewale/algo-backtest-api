import Bull from 'bull';
import { BacktestConfig, BacktestResult } from '../types';
import { runBacktestEngine } from '../core/engine/backtestEngine';
import { BacktestJobModel } from '../models';
import { publishProgress } from '../cache/redis';
import logger from '../utils/logger';

// ─── Queue definition ─────────────────────────────────────────────────────────

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

export const backtestQueue = new Bull<BacktestJobPayload>('backtest', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 100,
    timeout: 10 * 60 * 1000, // 10 min max per job
  },
});

export interface BacktestJobPayload {
  jobId: string;
  config: BacktestConfig;
}

// ─── Queue a backtest ─────────────────────────────────────────────────────────

export async function enqueueBacktest(
  jobId: string,
  config: BacktestConfig,
  priority: 'low' | 'normal' | 'high' = 'normal',
): Promise<Bull.Job<BacktestJobPayload>> {
  const priorityMap = { low: 20, normal: 10, high: 1 };
  return backtestQueue.add({ jobId, config }, { priority: priorityMap[priority], jobId });
}

// ─── Worker process ────────────────────────────────────────────────────────────

export function startBacktestWorker(): void {
  const concurrency = parseInt(process.env.BACKTEST_WORKER_CONCURRENCY || '3');

  backtestQueue.process(concurrency, async (job) => {
    const { jobId, config } = job.data;
    logger.info(`Worker processing job ${jobId}`, { config: config.name });

    // Mark as running in MongoDB
    await BacktestJobModel.updateOne(
      { jobId },
      { $set: { status: 'running', startedAt: new Date(), progress: 0 } },
    );

    try {
      const result: BacktestResult = await runBacktestEngine(config, async (pct) => {
        await job.progress(pct);
        await BacktestJobModel.updateOne({ jobId }, { $set: { progress: pct } });
        // Publish to Redis pub/sub so WebSocket gateway can relay to subscribed clients
        await publishProgress({ jobId, status: 'running', progress: pct });
      });

      // Save completed result
      await BacktestJobModel.updateOne(
        { jobId },
        { $set: { status: 'completed', completedAt: new Date(), progress: 100, result } },
      );
      await publishProgress({ jobId, status: 'completed', progress: 100 });
      logger.info(`Job ${jobId} completed — ${result.trades.length} trades, PnL: ₹${result.summary.netPnl}`);
      return result;

    } catch (err: any) {
      logger.error(`Job ${jobId} failed`, { error: err.message });
      await BacktestJobModel.updateOne(
        { jobId },
        {
          $set: {
            status: 'failed',
            completedAt: new Date(),
            error: err.message,
          },
        },
      );
      throw err;
    }
  });

  // ── Event handlers ──
  backtestQueue.on('completed', (job) => {
    logger.info(`Bull job completed: ${job.data.jobId}`);
  });

  backtestQueue.on('failed', (job, err) => {
    logger.error(`Bull job failed: ${job.data.jobId}`, { error: err.message });
  });

  backtestQueue.on('stalled', (job) => {
    logger.warn(`Bull job stalled: ${job.data.jobId}`);
  });

  backtestQueue.on('progress', (job, progress) => {
    logger.debug(`Job ${job.data.jobId} progress: ${progress}%`);
  });

  logger.info(`Backtest worker started (concurrency: ${concurrency})`);
}

// ─── Queue stats ──────────────────────────────────────────────────────────────

export async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    backtestQueue.getWaitingCount(),
    backtestQueue.getActiveCount(),
    backtestQueue.getCompletedCount(),
    backtestQueue.getFailedCount(),
    backtestQueue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const job = await backtestQueue.getJob(jobId);
  if (!job) return false;
  await job.remove();
  await BacktestJobModel.updateOne(
    { jobId },
    { $set: { status: 'failed', error: 'Cancelled by user', completedAt: new Date() } },
  );
  return true;
}
