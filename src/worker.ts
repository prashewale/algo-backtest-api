/**
 * Standalone worker process.
 * Run independently: `npm run worker`
 * Or alongside the API: both connect to the same Bull queue via Redis.
 */
import 'dotenv/config';
import { connectMongo } from './models';
import { startBacktestWorker, backtestQueue } from './workers/backtestWorker';
import logger from './utils/logger';

async function startWorker() {
  try {
    logger.info('Starting standalone backtest worker…');

    await connectMongo(process.env.MONGODB_URI!);
    startBacktestWorker();

    logger.info('Worker ready and listening for jobs');
    logger.info(`Concurrency: ${process.env.BACKTEST_WORKER_CONCURRENCY || 3}`);

    // Keep alive
    process.on('SIGTERM', async () => {
      logger.info('Worker SIGTERM — draining queue and shutting down');
      await backtestQueue.close();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('Worker SIGINT — shutting down');
      await backtestQueue.close();
      process.exit(0);
    });

  } catch (err) {
    logger.error('Worker failed to start', { err });
    process.exit(1);
  }
}

startWorker();
