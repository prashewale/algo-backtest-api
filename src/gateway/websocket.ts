/**
 * WebSocket gateway.
 * Provides real-time job progress updates and simulator candle streaming.
 *
 * Protocol (JSON messages):
 *
 * CLIENT → SERVER:
 *   { type: "subscribe_job",     jobId: string }
 *   { type: "unsubscribe_job",   jobId: string }
 *   { type: "subscribe_sim",     sessionId: string }
 *   { type: "unsubscribe_sim",   sessionId: string }
 *   { type: "sim_advance",       sessionId: string, steps: number }
 *   { type: "ping" }
 *
 * SERVER → CLIENT:
 *   { type: "job_progress",      jobId, status, progress, error? }
 *   { type: "job_completed",     jobId, summary }
 *   { type: "job_failed",        jobId, error }
 *   { type: "sim_candle",        sessionId, candle, spot, vix, positions, totalPnl }
 *   { type: "sim_error",         sessionId, error }
 *   { type: "pong" }
 *   { type: "error",             message }
 */

import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { subscribeProgress, JobProgressEvent } from '../cache/redis';
import { advanceCandles, getMarketSnapshot } from '../core/simulator/simulator';
import { BacktestJobModel } from '../models';
import logger from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WsClient {
  ws:           WebSocket;
  subscribedJobs: Set<string>;
  subscribedSims: Set<string>;
  alive:        boolean;
}

type IncomingMessage =
  | { type: 'subscribe_job';   jobId: string }
  | { type: 'unsubscribe_job'; jobId: string }
  | { type: 'subscribe_sim';   sessionId: string }
  | { type: 'unsubscribe_sim'; sessionId: string }
  | { type: 'sim_advance';     sessionId: string; steps?: number }
  | { type: 'ping' };

// ─── Gateway ──────────────────────────────────────────────────────────────────

export class WebSocketGateway {
  private wss:     WebSocketServer;
  private clients: Map<WebSocket, WsClient> = new Map();
  private unsubscribeProgress?: () => Promise<void>;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.setupConnectionHandler();
    this.setupProgressSubscriber();
    this.startHeartbeat();
    logger.info('WebSocket gateway started at /ws');
  }

  // ─── Connection handler ─────────────────────────────────────────────────────

  private setupConnectionHandler() {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      logger.debug(`WS client connected: ${ip}`);

      const client: WsClient = {
        ws,
        subscribedJobs: new Set(),
        subscribedSims: new Set(),
        alive: true,
      };
      this.clients.set(ws, client);

      ws.on('message', (data) => this.handleMessage(client, data.toString()));
      ws.on('pong',    () => { client.alive = true; });
      ws.on('close',   () => {
        this.clients.delete(ws);
        logger.debug(`WS client disconnected: ${ip}`);
      });
      ws.on('error', (err) => {
        logger.debug(`WS client error: ${err.message}`);
        this.clients.delete(ws);
      });

      this.send(ws, { type: 'connected', message: 'Algo Backtest WS gateway ready' });
    });
  }

  // ─── Message handler ────────────────────────────────────────────────────────

  private async handleMessage(client: WsClient, raw: string) {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(client.ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {

      case 'ping':
        this.send(client.ws, { type: 'pong' });
        break;

      case 'subscribe_job': {
        const { jobId } = msg;
        client.subscribedJobs.add(jobId);
        // Send current status immediately
        try {
          const job = await BacktestJobModel.findOne({ jobId }, { status: 1, progress: 1, error: 1 }).lean();
          if (job) {
            this.send(client.ws, {
              type: 'job_progress',
              jobId,
              status:   (job as any).status,
              progress: (job as any).progress ?? 0,
            });
          }
        } catch { /* ignore */ }
        break;
      }

      case 'unsubscribe_job':
        client.subscribedJobs.delete(msg.jobId);
        break;

      case 'subscribe_sim': {
        const { sessionId } = msg;
        client.subscribedSims.add(sessionId);
        // Send current candle snapshot immediately
        try {
          const snapshot = await getMarketSnapshot(sessionId);
          if (snapshot) {
            this.send(client.ws, { type: 'sim_candle', sessionId, ...snapshot });
          }
        } catch (err: any) {
          this.send(client.ws, { type: 'sim_error', sessionId, error: err.message });
        }
        break;
      }

      case 'unsubscribe_sim':
        client.subscribedSims.delete(msg.sessionId);
        break;

      case 'sim_advance': {
        const { sessionId, steps = 1 } = msg;
        if (!client.subscribedSims.has(sessionId)) {
          this.send(client.ws, { type: 'error', message: 'Not subscribed to this session' });
          break;
        }
        try {
          const session = await advanceCandles(sessionId, steps);
          if (!session) {
            this.send(client.ws, { type: 'sim_error', sessionId, error: 'End of data' });
            break;
          }
          const snapshot = await getMarketSnapshot(sessionId);
          if (snapshot) {
            // Broadcast to ALL clients subscribed to this session
            this.broadcastToSimSubscribers(sessionId, {
              type: 'sim_candle',
              sessionId,
              ...snapshot,
              positions: session.positions,
              totalPnl:  session.totalPnl,
            });
          }
        } catch (err: any) {
          this.send(client.ws, { type: 'sim_error', sessionId, error: err.message });
        }
        break;
      }

      default:
        this.send(client.ws, { type: 'error', message: `Unknown message type: ${(msg as any).type}` });
    }
  }

  // ─── Progress subscriber ────────────────────────────────────────────────────

  private setupProgressSubscriber() {
    this.unsubscribeProgress = subscribeProgress((event: JobProgressEvent) => {
      this.broadcastJobProgress(event);
    });
  }

  private broadcastJobProgress(event: JobProgressEvent) {
    const msg: Record<string, unknown> = {
      type:     'job_progress',
      jobId:    event.jobId,
      status:   event.status,
      progress: event.progress,
    };

    if (event.status === 'completed') msg.type = 'job_completed';
    if (event.status === 'failed')    { msg.type = 'job_failed'; msg.error = event.error; }

    for (const client of this.clients.values()) {
      if (client.subscribedJobs.has(event.jobId)) {
        this.send(client.ws, msg);
      }
    }
  }

  private broadcastToSimSubscribers(sessionId: string, msg: Record<string, unknown>) {
    for (const client of this.clients.values()) {
      if (client.subscribedSims.has(sessionId)) {
        this.send(client.ws, msg);
      }
    }
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────────

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, client] of this.clients.entries()) {
        if (!client.alive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        client.alive = false;
        ws.ping();
      }
    }, 30_000);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private send(ws: WebSocket, data: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /** Push a job progress update from the API server (e.g., on job create). */
  public notifyJobUpdate(event: JobProgressEvent) {
    this.broadcastJobProgress(event);
  }

  public get connectedClients(): number {
    return this.clients.size;
  }

  async close() {
    clearInterval(this.heartbeatTimer);
    if (this.unsubscribeProgress) await this.unsubscribeProgress();
    this.wss.close();
  }
}
