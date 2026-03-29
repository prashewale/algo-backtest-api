import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, validateBody, validateQuery } from '../middleware';
import { CreateBacktestSchema, BacktestListQuerySchema } from '../middleware/validation';
import { BacktestJobModel } from '../../models';
import { enqueueBacktest, getQueueStats, cancelJob } from '../../workers/backtestWorker';
import logger from '../../utils/logger';

const router = Router();

// ─── POST /backtests — create & queue ────────────────────────────────────────

router.post('/',
  validateBody(CreateBacktestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { config, priority } = req.body;
    const jobId = uuidv4();

    // Persist job record before queuing
    await BacktestJobModel.create({ jobId, status: 'queued', config, progress: 0 });

    // Queue with Bull
    await enqueueBacktest(jobId, config, priority);

    logger.info(`Backtest queued: ${jobId} [${config.instrument} ${config.startDate}→${config.endDate}]`);

    res.status(202).json({
      jobId,
      status: 'queued',
      message: `Backtest "${config.name}" queued successfully`,
      pollUrl: `/api/backtests/${jobId}`,
    });
  }),
);

// ─── GET /backtests — list with pagination ────────────────────────────────────

router.get('/',
  validateQuery(BacktestListQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { page, pageSize, status, instrument } = (req as any).validQuery;
    const filter: Record<string, any> = {};
    if (status)     filter.status = status;
    if (instrument) filter['config.instrument'] = instrument;

    const [data, total] = await Promise.all([
      BacktestJobModel.find(filter, { result: 0 })  // exclude heavy result in list
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      BacktestJobModel.countDocuments(filter),
    ]);

    res.json({ data, total, page, pageSize, hasMore: page * pageSize < total });
  }),
);

// ─── GET /backtests/queue — queue stats ──────────────────────────────────────

router.get('/queue',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = await getQueueStats();
    res.json(stats);
  }),
);

// ─── GET /backtests/:jobId — get status + result ──────────────────────────────

router.get('/:jobId',
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const job = await BacktestJobModel.findOne({ jobId }).lean();
    if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found' });
    res.json(job);
  }),
);

// ─── GET /backtests/:jobId/result — get only the result ──────────────────────

router.get('/:jobId/result',
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const job = await BacktestJobModel.findOne({ jobId }, { result: 1, status: 1, error: 1 }).lean();
    if (!job)           return res.status(404).json({ code: 'NOT_FOUND',      message: 'Job not found' });
    if (job.status !== 'completed') return res.status(409).json({ code: 'NOT_READY', message: `Job status: ${job.status}` });
    res.json(job.result);
  }),
);

// ─── GET /backtests/:jobId/trades — paginated trade log ──────────────────────

router.get('/:jobId/trades',
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const page     = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 500);
    const statusFilter = req.query.status as string;

    const job = await BacktestJobModel.findOne({ jobId }, { 'result.trades': 1, status: 1 }).lean();
    if (!job)                       return res.status(404).json({ code: 'NOT_FOUND',  message: 'Job not found' });
    if (job.status !== 'completed') return res.status(409).json({ code: 'NOT_READY',  message: `Job status: ${job.status}` });

    let trades = (job as any).result?.trades ?? [];
    if (statusFilter && ['WIN','LOSS','BREAKEVEN'].includes(statusFilter)) {
      trades = trades.filter((t: any) => t.status === statusFilter);
    }

    const total = trades.length;
    const paginated = trades.slice((page - 1) * pageSize, page * pageSize);
    res.json({ data: paginated, total, page, pageSize, hasMore: page * pageSize < total });
  }),
);

// ─── DELETE /backtests/:jobId — cancel or delete ──────────────────────────────

router.delete('/:jobId',
  asyncHandler(async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const job = await BacktestJobModel.findOne({ jobId }).lean();
    if (!job) return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found' });

    if (job.status === 'queued' || job.status === 'running') {
      await cancelJob(jobId);
      return res.json({ message: 'Job cancelled' });
    }

    await BacktestJobModel.deleteOne({ jobId });
    res.json({ message: 'Job deleted' });
  }),
);

export default router;
