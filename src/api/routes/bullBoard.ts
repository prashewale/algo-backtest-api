/**
 * Bull Board UI — embedded in the Express app at /admin/queues
 * Visit http://localhost:3000/admin/queues to see the queue dashboard.
 *
 * Only enabled when NODE_ENV !== 'production' OR when BULL_BOARD=1.
 */
import { Router } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { backtestQueue } from '../../workers/backtestWorker';

export function createBullBoardRouter(): Router {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: [new BullAdapter(backtestQueue)],
    serverAdapter,
  });

  return serverAdapter.getRouter();
}
