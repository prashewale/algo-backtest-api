/**
 * Redis cache service.
 * Wraps expensive computations (analytics, processed candles, expiry lists)
 * with a simple get/set/invalidate API backed by ioredis.
 */

import Redis from 'ioredis';
import logger from '../utils/logger';

// ─── Connection ───────────────────────────────────────────────────────────────

let redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (redis) return redis;
  redis = new Redis({
    host:     process.env.REDIS_HOST     || 'localhost',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    keyPrefix: 'algo:',
    retryStrategy: (times) => Math.min(times * 100, 3000),
    lazyConnect: true,
  });
  redis.on('error', (err) => logger.error('Redis error', { err: err.message }));
  redis.on('connect', () => logger.debug('Redis connected'));
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) { await redis.quit(); redis = null; }
}

// ─── Cache key builders ───────────────────────────────────────────────────────

export const CacheKeys = {
  analytics:       (jobId: string)                         => `analytics:${jobId}`,
  processedCandle: (instrument: string, candle: string)    => `candle:${instrument}:${candle}`,
  availableDays:   (instrument: string, year: number)      => `days:${instrument}:${year}`,
  expiries:        (instrument: string, date: string)      => `expiries:${instrument}:${date}`,
  chainSnapshot:   (instrument: string, candle: string)    => `chain:${instrument}:${candle}`,
  marginCalc:      (hash: string)                          => `margin:${hash}`,
  jobStatus:       (jobId: string)                         => `job:status:${jobId}`,
};

// ─── TTLs (seconds) ───────────────────────────────────────────────────────────

export const TTL = {
  analytics:       60 * 60 * 2,    // 2 hours  — heavy computation
  processedCandle: 60 * 60 * 24,   // 24 hours — immutable historical data
  availableDays:   60 * 60 * 6,    // 6 hours
  expiries:        60 * 60 * 6,    // 6 hours
  chainSnapshot:   60 * 60 * 24,   // 24 hours — historical, never changes
  marginCalc:      60 * 5,         // 5 minutes
  jobStatus:       5,              // 5 seconds — very short, for polling
};

// ─── Generic cache helpers ────────────────────────────────────────────────────

/**
 * Get a cached value. Returns null on miss or Redis error.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const client = getRedisClient();
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.debug('Cache get error', { key, err });
    return null;
  }
}

/**
 * Set a cached value with TTL.
 */
export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    const client = getRedisClient();
    await client.setex(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    logger.debug('Cache set error', { key, err });
  }
}

/**
 * Delete a cached value.
 */
export async function cacheDelete(key: string): Promise<void> {
  try {
    const client = getRedisClient();
    await client.del(key);
  } catch (err) {
    logger.debug('Cache delete error', { key, err });
  }
}

/**
 * Delete all keys matching a pattern.
 */
export async function cacheInvalidatePattern(pattern: string): Promise<number> {
  try {
    const client = getRedisClient();
    const keys = await client.keys(`algo:${pattern}`);
    if (!keys.length) return 0;
    // Strip the keyPrefix since ioredis adds it automatically for del
    const unprefixed = keys.map(k => k.replace(/^algo:/, ''));
    await client.del(...unprefixed);
    return unprefixed.length;
  } catch (err) {
    logger.debug('Cache invalidate error', { pattern, err });
    return 0;
  }
}

/**
 * Cache-aside helper: get from cache or compute and store.
 */
export async function cacheGetOrSet<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    logger.debug('Cache hit', { key });
    return cached;
  }
  logger.debug('Cache miss', { key });
  const value = await compute();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

// ─── Job progress pub/sub ─────────────────────────────────────────────────────
// Workers publish progress events; the WebSocket gateway subscribes.

export const PROGRESS_CHANNEL = 'algo:job:progress';

export interface JobProgressEvent {
  jobId:    string;
  status:   'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  error?:   string;
}

/**
 * Publish a job progress event. Called by the worker.
 */
export async function publishProgress(event: JobProgressEvent): Promise<void> {
  try {
    // Use a separate non-keyed client for pub/sub (ioredis requirement)
    const client = new Redis({
      host:     process.env.REDIS_HOST     || 'localhost',
      port:     parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
    });
    await client.publish(PROGRESS_CHANNEL, JSON.stringify(event));
    await client.quit();
  } catch (err) {
    logger.debug('Progress publish error', { err });
  }
}

/**
 * Subscribe to job progress events. Returns an unsubscribe function.
 * Used by the WebSocket gateway.
 */
export function subscribeProgress(
  onEvent: (event: JobProgressEvent) => void,
): () => Promise<void> {
  const subscriber = new Redis({
    host:     process.env.REDIS_HOST     || 'localhost',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
  });

  subscriber.subscribe(PROGRESS_CHANNEL, (err) => {
    if (err) logger.error('Progress subscribe error', { err });
  });

  subscriber.on('message', (_channel: string, message: string) => {
    try {
      onEvent(JSON.parse(message) as JobProgressEvent);
    } catch { /* bad message, ignore */ }
  });

  return async () => {
    await subscriber.unsubscribe();
    await subscriber.quit();
  };
}

// ─── Simple hash for margin cache key ────────────────────────────────────────

export function hashObject(obj: unknown): string {
  const str = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}
