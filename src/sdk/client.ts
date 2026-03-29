/**
 * Algo Backtest API — TypeScript SDK Client
 *
 * Usage (Node.js or browser):
 *   import { AlgoBacktestClient } from './sdk/client';
 *   const client = new AlgoBacktestClient('http://localhost:3000');
 *   const job = await client.backtests.create({ config: { ... } });
 *   const result = await client.backtests.waitForResult(job.jobId);
 */

// ─── Re-export shared types for SDK consumers ─────────────────────────────────

export type {
  Instrument, OptionType, TradeAction,
  BacktestConfig, BacktestResult, BacktestSummary,
  BacktestJob, TradeRecord, EquityPoint, MonthlyPnl,
  StrategyLeg, StrikeSelection, ExpirySelection,
  ConditionTree, ConditionNode, ConditionGroup,
  StrategyConditions, RiskRules,
  SimulatorSession, SimulatorPosition,
  ProcessedCandle, ProcessedExpiry, ProcessedStrike, GreekSnapshot,
} from '../types';

// ─── SDK-specific types ───────────────────────────────────────────────────────

export interface SdkConfig {
  baseUrl:     string;
  timeout?:    number;    // ms, default 30000
  retries?:    number;    // default 0
  headers?:    Record<string, string>;
}

export interface PollOptions {
  intervalMs?:    number;   // default 2000
  timeoutMs?:     number;   // default 600000 (10 min)
  onProgress?:    (pct: number) => void;
}

export interface CreateBacktestOptions {
  config:     import('../types').BacktestConfig;
  priority?:  'low' | 'normal' | 'high';
}

export interface ListBacktestsOptions {
  page?:        number;
  pageSize?:    number;
  status?:      'queued' | 'running' | 'completed' | 'failed';
  instrument?:  import('../types').Instrument;
}

export interface ListTradesOptions {
  page?:       number;
  pageSize?:   number;
  status?:     'WIN' | 'LOSS' | 'BREAKEVEN';
}

export interface OpenPositionOptions {
  expiry:      string;
  strike:      number;
  optionType:  import('../types').OptionType;
  action:      import('../types').TradeAction;
  lots:        number;
  lotSize:     number;
}

// ─── HTTP fetch wrapper ───────────────────────────────────────────────────────

class HttpClient {
  constructor(private cfg: Required<SdkConfig>) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(path, this.cfg.baseUrl);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeout);

    try {
      const res = await fetch(url.toString(), {
        method,
        headers: { 'Content-Type': 'application/json', ...this.cfg.headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new ApiError(res.status, (err as any).code ?? 'API_ERROR', (err as any).message ?? res.statusText, err);
      }

      return res.json() as Promise<T>;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ApiError) throw e;
      throw new ApiError(0, 'NETWORK_ERROR', (e as Error).message);
    }
  }

  get<T>(path: string, q?: Record<string, string | number | boolean | undefined>)   { return this.request<T>('GET',    path, undefined, q); }
  post<T>(path: string, body?: unknown)                                   { return this.request<T>('POST',   path, body); }
  delete<T>(path: string, body?: unknown)                                 { return this.request<T>('DELETE', path, body); }
}

export class ApiError extends Error {
  constructor(
    public readonly status:  number,
    public readonly code:    string,
    message: string,
    public readonly details?: unknown,
  ) { super(message); this.name = 'ApiError'; }
}

// ─── Resource clients ─────────────────────────────────────────────────────────

class BacktestsClient {
  constructor(private http: HttpClient) {}

  /** Create and queue a new backtest. Returns immediately with jobId. */
  async create(opts: CreateBacktestOptions): Promise<{ jobId: string; status: string; pollUrl: string }> {
    return this.http.post('/api/backtests', opts);
  }

  /** List backtest jobs. */
  async list(opts: ListBacktestsOptions = {}) {
    return this.http.get<{ data: import('../types').BacktestJob[]; total: number; hasMore: boolean }>(
      '/api/backtests',
      { page: opts.page, pageSize: opts.pageSize, status: opts.status, instrument: opts.instrument },
    );
  }

  /** Get job status and result. */
  async get(jobId: string): Promise<import('../types').BacktestJob> {
    return this.http.get(`/api/backtests/${jobId}`);
  }

  /** Get only the result (throws if not completed). */
  async getResult(jobId: string): Promise<import('../types').BacktestResult> {
    return this.http.get(`/api/backtests/${jobId}/result`);
  }

  /** Get paginated trade log. */
  async getTrades(jobId: string, opts: ListTradesOptions = {}) {
    return this.http.get<{ data: import('../types').TradeRecord[]; total: number; hasMore: boolean }>(
      `/api/backtests/${jobId}/trades`,
      { page: opts.page, pageSize: opts.pageSize, status: opts.status },
    );
  }

  /** Cancel or delete a job. */
  async cancel(jobId: string): Promise<{ message: string }> {
    return this.http.delete(`/api/backtests/${jobId}`);
  }

  /** Queue stats. */
  async queueStats() {
    return this.http.get<{ waiting: number; active: number; completed: number; failed: number }>('/api/backtests/queue');
  }

  /**
   * Poll until job completes or fails.
   * Returns the full BacktestResult on success.
   */
  async waitForResult(
    jobId: string,
    opts: PollOptions = {},
  ): Promise<import('../types').BacktestResult> {
    const { intervalMs = 2000, timeoutMs = 600_000, onProgress } = opts;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const job = await this.get(jobId);

      if (onProgress && job.progress !== undefined) onProgress(job.progress);

      if (job.status === 'completed') {
        return job.result!;
      }
      if (job.status === 'failed') {
        throw new ApiError(500, 'JOB_FAILED', job.error ?? 'Backtest failed');
      }
      await sleep(intervalMs);
    }
    throw new ApiError(408, 'POLL_TIMEOUT', `Job ${jobId} did not complete within ${timeoutMs}ms`);
  }

  /**
   * Convenience: create backtest and wait for result in one call.
   */
  async run(
    opts: CreateBacktestOptions,
    pollOpts: PollOptions = {},
  ): Promise<import('../types').BacktestResult> {
    const { jobId } = await this.create(opts);
    return this.waitForResult(jobId, pollOpts);
  }
}

class SimulatorClient {
  constructor(private http: HttpClient) {}

  /** Start a new simulator session. */
  async createSession(opts: {
    instrument: import('../types').Instrument;
    startCandle: string;
    initialCapital?: number;
  }): Promise<import('../types').SimulatorSession> {
    return this.http.post('/api/simulator/sessions', {
      ...opts,
      initialCapital: opts.initialCapital ?? 500_000,
    });
  }

  /** Get session state. */
  async getSession(sessionId: string): Promise<import('../types').SimulatorSession> {
    return this.http.get(`/api/simulator/sessions/${sessionId}`);
  }

  /** Delete (close) a session. */
  async deleteSession(sessionId: string): Promise<{ message: string }> {
    return this.http.delete(`/api/simulator/sessions/${sessionId}`);
  }

  /** Get market snapshot at current candle. */
  async getMarket(sessionId: string) {
    return this.http.get<{
      candle: string;
      spot:   number;
      vix:    number;
      nearestExpiry: { expiry: string; daysToExpiry: number; atmStrike: number; straddlePremium: number; chain: import('../types').ProcessedStrike[] } | null;
      allExpiries: { expiry: string; daysToExpiry: number; atmStrike: number; straddlePremium: number }[];
    }>(`/api/simulator/sessions/${sessionId}/market`);
  }

  /** Full candle data + live P&L on all positions. */
  async getCandle(sessionId: string) {
    return this.http.get<{ candle: import('../types').RawOptionChainDocument; session: import('../types').SimulatorSession }>(
      `/api/simulator/sessions/${sessionId}/candle`,
    );
  }

  /** Advance N candles forward. */
  async advance(sessionId: string, steps: number = 1): Promise<import('../types').SimulatorSession> {
    return this.http.post(`/api/simulator/sessions/${sessionId}/advance`, { steps });
  }

  /** Jump to a specific candle datetime. */
  async jump(sessionId: string, candleDatetime: string): Promise<import('../types').SimulatorSession> {
    return this.http.post(`/api/simulator/sessions/${sessionId}/jump`, { candleDatetime });
  }

  /** Open a position. */
  async openPosition(
    sessionId: string,
    opts: OpenPositionOptions,
  ): Promise<{ session: import('../types').SimulatorSession; position: import('../types').SimulatorPosition }> {
    return this.http.post(`/api/simulator/sessions/${sessionId}/positions`, opts);
  }

  /** Close a position (optionally partial). */
  async closePosition(
    sessionId: string,
    positionId: string,
    lots?: number,
  ): Promise<{ session: import('../types').SimulatorSession; pnl: number }> {
    return this.http.delete(`/api/simulator/sessions/${sessionId}/positions/${positionId}`, lots !== undefined ? { lots } : {});
  }

  /** Get available trading days (for calendar UI). */
  async availableDays(instrument: import('../types').Instrument, year: number): Promise<{ days: string[]; count: number }> {
    return this.http.get(`/api/simulator/available-days`, { instrument, year });
  }
}

class MarketClient {
  constructor(private http: HttpClient) {}

  getCandle(instrument: import('../types').Instrument, datetime: string, include?: 'processed') {
    return this.http.get<import('../types').RawOptionChainDocument>('/api/market/candle', { instrument, datetime, include });
  }

  getChain(instrument: import('../types').Instrument, datetime: string, expiry?: string) {
    return this.http.get<{ candle: string; spot: number; expiries: import('../types').ProcessedExpiry[] }>(
      '/api/market/chain', { instrument, datetime, expiry },
    );
  }

  getCandles(instrument: import('../types').Instrument, startDate: string, endDate: string, opts?: { entryTime?: string; exitTime?: string; processed?: boolean }) {
    return this.http.get<{ count: number; candles: import('../types').RawOptionChainDocument[] }>(
      '/api/market/candles', {
        instrument, startDate, endDate,
        entryTime:  opts?.entryTime,
        exitTime:   opts?.exitTime,
        processed:  opts?.processed ? 'true' : undefined,
      },
    );
  }

  getExpiries(instrument: import('../types').Instrument, date: string) {
    return this.http.get<{ date: string; expiries: { expiry: string; impliedFuture: number; daysToExpiry: number }[] }>(
      '/api/market/expiries', { instrument, date },
    );
  }

  availableDays(instrument: import('../types').Instrument, year: number) {
    return this.http.get<{ days: string[]; count: number }>('/api/market/available-days', { instrument, year });
  }

  stats(instrument: import('../types').Instrument, year: number) {
    return this.http.get<{ collection: string; totalCandles: number; earliestCandle: string; latestCandle: string }>(
      '/api/market/stats', { instrument, year },
    );
  }
}

class StrategyClient {
  constructor(private http: HttpClient) {}

  listTemplates() {
    return this.http.get<import('../services/strategyTemplates').StrategyTemplate[]>('/api/strategy/templates');
  }

  getTemplate(key: string) {
    return this.http.get<import('../services/strategyTemplates').StrategyTemplate>(`/api/strategy/templates/${key}`);
  }

  buildFromTemplate(opts: {
    templateKey: string;
    instrument: import('../types').Instrument;
    startDate: string; endDate: string;
    capital: number; lotSize: number;
    name?: string; entryTime?: string; exitTime?: string;
  }): Promise<import('../types').BacktestConfig> {
    return this.http.post('/api/strategy/from-template', opts);
  }

  calculateMargin(opts: {
    CalculateForExpiryDay: boolean;
    IndexPrices: Record<string, number>;
    ListOfPosition: import('../services/marginCalculator').MarginPosition[];
  }) {
    return this.http.post<import('../services/marginCalculator').MarginResult>('/api/strategy/calculate-margin', opts);
  }
}

class AnalyticsClient {
  constructor(private http: HttpClient) {}

  getExtended(jobId: string) {
    return this.http.get<import('../core/analytics/analytics').ExtendedAnalytics>(`/api/analytics/${jobId}`);
  }

  getDrawdowns(jobId: string) {
    return this.http.get<{ drawdownPeriods: import('../core/analytics/analytics').DrawdownPeriod[] }>(`/api/analytics/${jobId}/drawdowns`);
  }

  compare(jobId: string, otherJobIds: string[]) {
    const joined = otherJobIds.join(',');
    return this.http.get<{ comparisons: { jobId: string; name: string; summary: import('../types').BacktestSummary }[] }>(
      `/api/analytics/${jobId}/compare`, { jobIds: joined },
    );
  }
}

// ─── Main client ──────────────────────────────────────────────────────────────

export class AlgoBacktestClient {
  public readonly backtests: BacktestsClient;
  public readonly simulator: SimulatorClient;
  public readonly market:    MarketClient;
  public readonly strategy:  StrategyClient;
  public readonly analytics: AnalyticsClient;

  private http: HttpClient;

  constructor(baseUrlOrConfig: string | SdkConfig) {
    const cfg: Required<SdkConfig> = typeof baseUrlOrConfig === 'string'
      ? { baseUrl: baseUrlOrConfig, timeout: 30_000, retries: 0, headers: {} }
      : { timeout: 30_000, retries: 0, headers: {}, ...baseUrlOrConfig };

    this.http      = new HttpClient(cfg);
    this.backtests = new BacktestsClient(this.http);
    this.simulator = new SimulatorClient(this.http);
    this.market    = new MarketClient(this.http);
    this.strategy  = new StrategyClient(this.http);
    this.analytics = new AnalyticsClient(this.http);
  }

  /** Health check. */
  health() {
    return this.http.get<{ status: string; uptime: number; queue: Record<string, number> }>('/health');
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── RawOptionChainDocument type (needed by SDK consumers) ────────────────────

interface RawOptionChainDocument {
  candle: string;
  underlying: string;
  cash: { timestamp: string; close: number };
  futures: Record<string, { timestamp: string; close: number }>;
  implied_futures: Record<string, number>;
  vix: { timestamp: string; close: number };
  options: Record<string, any>;
}
