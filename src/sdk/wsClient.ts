/**
 * WebSocket Client Examples
 *
 * Node.js:  npx ts-node src/sdk/wsClient.ts
 * Browser:  copy the BrowserWsClient class and use directly
 */

// ─── Node.js WS client (wraps the 'ws' library) ───────────────────────────────

export class AlgoWsClient {
  private ws: any;             // WebSocket instance (ws lib or browser native)
  private handlers = new Map<string, ((msg: any) => void)[]>();
  private reconnectDelay = 1000;
  private maxReconnect   = 5;
  private reconnectCount = 0;
  private url: string;

  constructor(url: string = 'ws://localhost:3000/ws') {
    this.url = url;
  }

  /** Connect and return a promise that resolves on first 'connected' message. */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const connect = () => {
        // Use browser WebSocket if available, else require 'ws'
        const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws');
        this.ws = new WS(this.url);

        this.ws.onopen = () => {
          this.reconnectCount = 0;
        };

        this.ws.onmessage = (event: any) => {
          try {
            const msg = JSON.parse(typeof event === 'string' ? event : event.data);
            if (!resolved && msg.type === 'connected') { resolved = true; resolve(); }
            this.emit(msg.type, msg);
            this.emit('*', msg); // wildcard
          } catch { /* bad message */ }
        };

        this.ws.onerror = (err: any) => {
          if (!resolved) reject(err);
        };

        this.ws.onclose = () => {
          if (this.reconnectCount < this.maxReconnect) {
            this.reconnectCount++;
            setTimeout(connect, this.reconnectDelay * this.reconnectCount);
          }
        };
      };

      connect();
    });
  }

  disconnect() {
    this.maxReconnect = 0; // prevent reconnect
    this.ws?.close();
  }

  on(type: string, handler: (msg: any) => void): this {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
    return this;
  }

  off(type: string, handler: (msg: any) => void): this {
    const hs = this.handlers.get(type) ?? [];
    this.handlers.set(type, hs.filter(h => h !== handler));
    return this;
  }

  private emit(type: string, msg: any) {
    for (const h of this.handlers.get(type) ?? []) h(msg);
  }

  private send(data: object) {
    if (this.ws?.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // ─── Job subscriptions ──────────────────────────────────────────────────────

  /** Subscribe to real-time progress for a backtest job. */
  subscribeJob(jobId: string): this {
    this.send({ type: 'subscribe_job', jobId });
    return this;
  }

  unsubscribeJob(jobId: string): this {
    this.send({ type: 'unsubscribe_job', jobId });
    return this;
  }

  /**
   * Subscribe to a job and return a promise that resolves with the
   * summary when the job completes (or rejects on failure).
   */
  waitForJob(jobId: string, onProgress?: (pct: number) => void): Promise<any> {
    return new Promise((resolve, reject) => {
      this.subscribeJob(jobId);

      const progressHandler = (msg: any) => {
        if (msg.jobId !== jobId) return;
        if (onProgress && msg.progress != null) onProgress(msg.progress);
        if (msg.type === 'job_completed') {
          this.off('job_completed', progressHandler);
          this.off('job_failed',    failHandler);
          this.unsubscribeJob(jobId);
          resolve(msg.summary);
        }
      };

      const failHandler = (msg: any) => {
        if (msg.jobId !== jobId) return;
        this.off('job_completed', progressHandler);
        this.off('job_failed',    failHandler);
        this.unsubscribeJob(jobId);
        reject(new Error(msg.error ?? 'Job failed'));
      };

      this.on('job_completed', progressHandler);
      this.on('job_failed',    failHandler);
      this.on('job_progress',  progressHandler);
    });
  }

  // ─── Simulator subscriptions ────────────────────────────────────────────────

  /** Subscribe to real-time candle updates for a simulator session. */
  subscribeSimulator(sessionId: string): this {
    this.send({ type: 'subscribe_sim', sessionId });
    return this;
  }

  unsubscribeSimulator(sessionId: string): this {
    this.send({ type: 'unsubscribe_sim', sessionId });
    return this;
  }

  /** Advance the simulator by N candles via WebSocket (no HTTP round-trip). */
  advanceSimulator(sessionId: string, steps: number = 1): this {
    this.send({ type: 'sim_advance', sessionId, steps });
    return this;
  }

  ping(): this {
    this.send({ type: 'ping' });
    return this;
  }
}

// ─── Node.js usage example ────────────────────────────────────────────────────

async function runExample() {
  const ws = new AlgoWsClient('ws://localhost:3000/ws');

  console.log('Connecting to WebSocket gateway…');
  await ws.connect();
  console.log('Connected');

  ws.ping();
  ws.on('pong', () => console.log('Pong received'));

  // ── Example 1: monitor a job submitted via HTTP ────────────────────────────

  console.log('\n--- Job monitoring example ---');
  console.log('(Paste a real jobId to test)');

  const mockJobId = 'demo-job-id'; // replace with real jobId from POST /api/backtests

  ws.subscribeJob(mockJobId);

  ws.on('job_progress', (msg) => {
    if (msg.jobId !== mockJobId) return;
    process.stdout.write(`\r  Progress: ${msg.progress}%   `);
  });

  ws.on('job_completed', (msg) => {
    if (msg.jobId !== mockJobId) return;
    console.log(`\n  Job completed! Net P&L: ₹${msg.summary?.netPnl?.toLocaleString() ?? 'N/A'}`);
  });

  ws.on('job_failed', (msg) => {
    if (msg.jobId !== mockJobId) return;
    console.error(`\n  Job failed: ${msg.error}`);
  });

  // ── Example 2: simulator real-time feed ────────────────────────────────────

  console.log('\n--- Simulator example ---');
  console.log('(Paste a real sessionId to test)');

  const mockSessionId = 'demo-session-id'; // replace with real sessionId

  ws.subscribeSimulator(mockSessionId);

  ws.on('sim_candle', (msg) => {
    if (msg.sessionId !== mockSessionId) return;
    console.log(`  Candle: ${msg.candle}  Spot: ₹${msg.spot?.toFixed(2)}  VIX: ${msg.vix?.toFixed(2)}`);
  });

  ws.on('sim_error', (msg) => {
    console.error(`  Simulator error: ${msg.error}`);
  });

  // Advance 5 candles with 1s gaps (demo only)
  let step = 0;
  const interval = setInterval(() => {
    if (++step > 5) {
      clearInterval(interval);
      ws.unsubscribeSimulator(mockSessionId);
      ws.disconnect();
      console.log('\nDone');
      return;
    }
    ws.advanceSimulator(mockSessionId, 1);
  }, 1000);
}

// Only run example when invoked directly (not when imported as module)
if (require.main === module) {
  runExample().catch(console.error);
}
