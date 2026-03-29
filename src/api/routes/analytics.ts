import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware';
import { BacktestJobModel } from '../../models';
import { computeExtendedAnalytics } from '../../core/analytics/analytics';
import { cacheGetOrSet, CacheKeys, TTL } from '../../cache/redis';

const router = Router();

/**
 * GET /api/analytics/:jobId
 * Compute and return extended analytics for a completed backtest.
 * Heavy — runs synchronously, consider caching in production.
 */
router.get('/:jobId',
  asyncHandler(async (req: Request, res: Response) => {
    const job = await BacktestJobModel.findOne(
      { jobId: req.params.jobId },
      { status: 1, result: 1 },
    ).lean();

    if (!job)
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Job not found' });
    if (job.status !== 'completed')
      return res.status(409).json({ code: 'NOT_READY', message: `Job status: ${job.status}` });

    const result = (job as any).result;
    if (!result)
      return res.status(404).json({ code: 'NO_RESULT', message: 'Result not found' });

    const analytics = await cacheGetOrSet(
      CacheKeys.analytics(req.params.jobId),
      TTL.analytics,
      async () => computeExtendedAnalytics(result),
    );
    res.json(analytics);
  }),
);

/**
 * GET /api/analytics/:jobId/drawdowns
 * Just the drawdown periods (lightweight).
 */
router.get('/:jobId/drawdowns',
  asyncHandler(async (req: Request, res: Response) => {
    const job = await BacktestJobModel.findOne(
      { jobId: req.params.jobId },
      { 'result.equityCurve': 1, status: 1 },
    ).lean();

    if (!job)          return res.status(404).json({ code: 'NOT_FOUND',  message: 'Job not found' });
    if (job.status !== 'completed')
      return res.status(409).json({ code: 'NOT_READY', message: `Job status: ${job.status}` });

    const analytics = computeExtendedAnalytics((job as any).result);
    res.json({ drawdownPeriods: analytics.drawdownPeriods });
  }),
);

/**
 * GET /api/analytics/:jobId/compare?jobIds=id1,id2,id3
 * Compare summary metrics across multiple completed backtests.
 */
router.get('/:jobId/compare',
  asyncHandler(async (req: Request, res: Response) => {
    const allIds = [
      req.params.jobId,
      ...((req.query.jobIds as string)?.split(',').filter(Boolean) ?? []),
    ].slice(0, 10); // max 10 comparisons

    const jobs = await BacktestJobModel.find(
      { jobId: { $in: allIds }, status: 'completed' },
      { jobId: 1, 'config.name': 1, 'config.instrument': 1, 'result.summary': 1 },
    ).lean();

    const comparisons = jobs.map((j: any) => ({
      jobId:      j.jobId,
      name:       j.config?.name,
      instrument: j.config?.instrument,
      summary:    j.result?.summary,
    }));

    res.json({ comparisons, count: comparisons.length });
  }),
);

export default router;
