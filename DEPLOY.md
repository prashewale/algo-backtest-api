# Deployment Guide

## Environment Variables (complete reference)

```bash
# ── Server ──────────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://yourdomain.com   # or * for dev

# ── MongoDB ─────────────────────────────────────────────────────────────────
# Collections: option_chain_nifty_2024, option_chain_banknifty_2025, etc.
MONGODB_URI=mongodb://user:pass@host:27017/algo_backtest?authSource=admin

# Atlas example:
# MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/algo_backtest

# ── Redis (for Bull queue + WebSocket pub/sub + caching) ─────────────────────
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password    # leave blank if no auth

# ── Worker ───────────────────────────────────────────────────────────────────
BACKTEST_WORKER_CONCURRENCY=3         # jobs processed in parallel per worker
                                      # 0 = API server does NOT process jobs

# ── Rate limiting ─────────────────────────────────────────────────────────────
RATE_LIMIT_WINDOW_MS=60000            # 1 minute window
RATE_LIMIT_MAX=100                    # max requests per window per IP

# ── Optional ─────────────────────────────────────────────────────────────────
LOG_LEVEL=info                        # debug | info | warn | error
BULL_BOARD=1                          # enable /admin/queues in production
```

---

## Local Development

```bash
# 1. Clone and install
git clone <repo>
cd algo-backtest-api
npm install

# 2. Start MongoDB + Redis via Docker
docker run -d -p 27017:27017 --name mongo mongo:7
docker run -d -p 6379:6379  --name redis redis:7-alpine

# 3. Configure environment
cp .env.example .env
# Edit MONGODB_URI and REDIS_HOST

# 4. Import your data
npx ts-node scripts/importData.ts --file ./sample-data.json
npx ts-node scripts/importData.ts --dir  ./data/

# 5. Create indexes (once after data load)
npm run indexes

# 6. Start API + worker (separate terminals)
npm run dev          # API on :3000
npm run dev:worker   # background worker
```

---

## Docker Compose (recommended)

```bash
# Start all services (API + Worker + MongoDB + Redis + Bull Board)
npm run docker:up

# Scale workers
docker-compose up --scale worker=5

# View logs
npm run docker:logs

# Stop
npm run docker:down
```

Services after `docker:up`:
| Service     | URL                              |
|-------------|----------------------------------|
| API         | http://localhost:3000            |
| WebSocket   | ws://localhost:3000/ws           |
| Bull Board  | http://localhost:3001            |
| MongoDB     | mongodb://localhost:27017        |
| Redis       | redis://localhost:6379           |

---

## Production (manual / bare metal)

### 1. Build

```bash
npm run build
# Output: dist/
```

### 2. Process manager (PM2)

```bash
npm install -g pm2

# Start API (no workers — set BACKTEST_WORKER_CONCURRENCY=0)
BACKTEST_WORKER_CONCURRENCY=0 pm2 start dist/index.js --name algo-api -i 2

# Start workers separately
BACKTEST_WORKER_CONCURRENCY=3 pm2 start dist/worker.js --name algo-worker -i 3

pm2 save
pm2 startup
```

### 3. Nginx reverse proxy

```nginx
upstream algo_api {
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;  # if running multiple API instances
    keepalive 32;
}

server {
    listen 443 ssl;
    server_name api.yourdomain.com;

    location / {
        proxy_pass         http://algo_api;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";      # required for WebSocket
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_read_timeout 600s;                      # long for backtest polling
    }
}
```

---

## MongoDB Setup for Production

### Indexes (critical for performance)

Run once after loading data:
```bash
npm run indexes
```

This creates `{ candle: 1 }` and `{ candle: 1, underlying: 1 }` indexes on every
`option_chain_*` collection. Without these, backtest queries will do full collection scans.

### Recommended MongoDB settings

```javascript
// mongosh
db.adminCommand({ setParameter: 1, wiredTigerCacheSizeGB: 4 })

// For a dedicated MongoDB server with 16GB RAM:
// wiredTigerCacheSizeGB = ~60% of RAM = 9-10GB
```

### Atlas (MongoDB cloud)

1. Create M30+ cluster (M10 is too small for large option chain datasets)
2. Enable compression: Zstandard (reduces storage 3–4×)
3. Create dedicated database user with `readWrite` on `algo_backtest`
4. Whitelist your server IPs
5. Use connection string: `mongodb+srv://...`

### Collection size estimates

| Instrument | Year  | Docs (approx) | Size (approx) |
|------------|-------|---------------|---------------|
| NIFTY      | 2024  | ~100,000      | ~2–4 GB       |
| BANKNIFTY  | 2024  | ~100,000      | ~2–4 GB       |
| All 6      | 2024  | ~600,000      | ~12–24 GB     |
| All 6      | 3 years | ~1.8M      | ~36–72 GB     |

---

## Redis Setup for Production

```bash
# Redis config (/etc/redis/redis.conf)
maxmemory 2gb
maxmemory-policy allkeys-lru
appendonly yes
appendfsync everysec
save 900 1
save 300 10
```

Redis is used for:
- Bull job queue (persistent)
- WebSocket pub/sub for job progress
- Response caching (analytics, candle data)

---

## Scaling Architecture

```
                    ┌─────────────────┐
                    │   Load Balancer  │
                    │  (Nginx/HAProxy) │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼────┐ ┌───────▼─────┐ ┌─────▼──────┐
    │  API Server   │ │  API Server  │ │ API Server  │
    │  (Node.js)    │ │  (Node.js)   │ │ (Node.js)   │
    │  Workers: 0   │ │  Workers: 0  │ │ Workers: 0  │
    └──────────────┘ └─────────────┘ └────────────┘
              │              │              │
              └──────────────┼──────────────┘
                             │ (Bull queue via Redis)
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼────┐ ┌───────▼─────┐ ┌─────▼──────┐
    │   Worker      │ │   Worker     │ │   Worker    │
    │  (Node.js)    │ │  (Node.js)   │ │ (Node.js)   │
    │  Concurr: 3   │ │  Concurr: 3  │ │ Concurr: 3  │
    └──────────────┘ └─────────────┘ └────────────┘
              │
    ┌─────────▼────────────────────┐
    │         MongoDB               │
    │  (Replica Set or Atlas)       │
    └───────────────────────────────┘
              │
    ┌─────────▼────────────────────┐
    │          Redis                │
    │  (Sentinel or Cluster)        │
    └───────────────────────────────┘
```

**API servers** handle HTTP/WebSocket — stateless, scale horizontally.
**Workers** process backtest jobs — CPU/memory bound, scale by adding more instances.
Separation means API stays responsive while long backtests run on workers.

---

## Data Import

### Single file
```bash
npx ts-node scripts/importData.ts --file ./data/nifty_2024_q1.json
```

### Directory of files
```bash
npx ts-node scripts/importData.ts --dir ./data/nifty_2024/
```

### NDJSON (fastest for large datasets)
```bash
# Convert JSON array to NDJSON first:
cat data.json | python3 -c "import json,sys; [print(json.dumps(d)) for d in json.load(sys.stdin)]" > data.ndjson

npx ts-node scripts/importData.ts --file data.ndjson --batch 1000
```

### Dry run (validate without writing)
```bash
npx ts-node scripts/importData.ts --file data.json --dry-run
```

The importer uses `upsert` (insert if not exists) so it's safe to re-run.

---

## WebSocket Protocol

Connect to `ws://host:3000/ws`

### Subscribe to job progress
```json
→ { "type": "subscribe_job", "jobId": "abc-123" }
← { "type": "job_progress",  "jobId": "abc-123", "status": "running", "progress": 45 }
← { "type": "job_completed", "jobId": "abc-123", "summary": { ... } }
← { "type": "job_failed",    "jobId": "abc-123", "error": "..." }
```

### Simulator real-time feed
```json
→ { "type": "subscribe_sim",  "sessionId": "sess-456" }
← { "type": "sim_candle", "sessionId": "sess-456", "candle": "2024-01-01T09:16:00",
    "spot": 21726, "vix": 14.83, "nearestExpiry": { ... } }
→ { "type": "sim_advance",    "sessionId": "sess-456", "steps": 1 }
← { "type": "sim_candle",     ... next candle ... }
```

---

## Running Tests

```bash
# All tests (unit + integration)
npm test

# Unit tests only (no DB/Redis required)
npx ts-node tests/run.ts --unit

# Integration tests only (no DB/Redis required — uses mock data)
npx ts-node tests/run.ts --integration

# Single test file
npx ts-node --transpile-only tests/unit/conditionEvaluator.test.ts
```

---

## Monitoring

### Health endpoint
`GET /health` returns:
```json
{
  "status": "ok",
  "uptime": 3600,
  "queue": { "waiting": 2, "active": 1, "completed": 150, "failed": 3 }
}
```

### Bull Board queue dashboard
`http://localhost:3000/admin/queues` (dev) or set `BULL_BOARD=1` in production.

Shows: queue depth, active jobs, job detail, retry failed jobs.

### Key metrics to monitor
- `queue.waiting` — job backlog (alert if > 20)
- `queue.failed`  — failed jobs (alert if rising)
- MongoDB `serverStatus().opcounters` — query volume
- Redis `info memory` — memory usage
- Node.js `process.memoryUsage().heapUsed` — worker heap (watch for leaks on long backtests)
