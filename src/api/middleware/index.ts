import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodSchema, ZodError } from 'zod';
import logger from '../../utils/logger';

// ─── Async handler wrapper ─────────────────────────────────────────────────────

export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler =>
  (req, res, next) => fn(req, res, next).catch(next);

// ─── Zod validation middleware ────────────────────────────────────────────────

export function validateBody<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: result.error.flatten(),
      });
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid query parameters',
        details: result.error.flatten(),
      });
    }
    (req as any).validQuery = result.data;
    next();
  };
}

// ─── Global error handler ─────────────────────────────────────────────────────

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) { next(err); return; }

  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (err instanceof ZodError) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Validation failed', details: err.flatten() });
    return;
  }

  if (err.name === 'CastError') {
    res.status(400).json({ code: 'INVALID_ID', message: 'Invalid identifier format' });
    return;
  }

  if (err.code === 11000) {
    res.status(409).json({ code: 'DUPLICATE', message: 'Resource already exists' });
    return;
  }

  const status = err.statusCode ?? err.status ?? 500;
  res.status(status).json({
    code: err.code ?? 'INTERNAL_ERROR',
    message: status === 500 ? 'Internal server error' : err.message,
  });
}

// ─── 404 handler ─────────────────────────────────────────────────────────────

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` });
}

// ─── Request timing ──────────────────────────────────────────────────────────

export function requestTimer(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    logger.debug(`${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}
