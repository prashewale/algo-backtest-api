# Algo Backtest API

TypeScript backend for options strategy backtesting on NSE instruments. Reads from MongoDB collections in the format `option_chain_{instrument}_{year}` (one document = one 1-minute candle).

---

## Architecture

```
algo-backtest-api/
├── src/
│   ├── index.ts                          # Express app + boot
│   ├── worker.ts                         # Standalone Bull worker entrypoint
│   ├── types/index.ts                    # All shared TypeScript types
│   ├── models/index.ts                   # Mongoose models — dynamic collection routing
│   ├── services/
│   │   ├── dataService.ts                # MongoDB fetch, candle processing, strike/expiry selection
│   │   ├── technicalIndicators.ts        # EMA, RSI, ATR, Bollinger, MACD, Supertrend
│   │   ├── marginCalculator.ts           # SPAN + Exposure margin (SEBI methodology)
│   │   └── strategyTemplates.ts          # 10 pre-built strategy templates
│   ├── core/
│   │   ├── conditions/evaluator.ts       # Nested AND/OR/NOT condition tree evaluator
│   │   ├── engine/backtestEngine.ts      # Candle-by-candle backtest loop
│   │   └── simulator/simulator.ts        # Manual options simulator (session-based)
│   ├── workers/
│   │   └── backtestWorker.ts             # Bull queue definition + worker processor
│   └── api/
│       ├── middleware/                   # Zod validation, error handler, async wrapper
│       └── routes/
│           ├── backtest.ts               # CRUD + polling for backtest jobs
│           ├── simulator.ts              # Simulator session + position management
│           ├── market.ts                 # Option chain exploration
│           └── strategy.ts              # Templates + margin calculation
├── scripts/
│   ├── createIndexes.ts                  # Create candle indexes on all collections
│   └── mongo-init.js                     # Docker MongoDB init
├── docker-compose.yml                    # API + Worker + MongoDB + Redis + Bull Board
├── Dockerfile                            # Multi-stage production build
└── api.http                              # All endpoint examples (VS Code REST Client)
```

---

## MongoDB Collection Format

Collections named: `option_chain_nifty_2024`, `option_chain_banknifty_2025`, etc.

Each document = 1 minute candle:

```json
{
  "candle": "2024-01-01T09:16:00",
  "underlying": "NIFTY",
  "cash": { "timestamp": "...", "close": 21710.4 },
  "futures": { "2024-01-25": { "timestamp": "...", "close": 21835 } },
  "implied_futures": { "2024-01-04": 21726.6 },
  "vix": { "timestamp": "...", "close": 14.83 },
  "options": {
    "2024-01-04": {
      "strike": [21600, 21650, 21700, ...],
      "call_close": [200.5, 150.3, 100.1, ...],
      "call_delta": [0.65, 0.55, 0.45, ...],
      "call_gamma": [...], "call_theta": [...],
      "call_vega": [...],  "call_rho": [...],
      "call_implied_vol": [...],
      "put_close": [...],  "put_delta": [...],
      ... (same structure for puts)
    }
  }
}
```

The engine automatically routes to the right collection by extracting the year from the date range.

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit MONGODB_URI, REDIS_HOST, etc.
```

### 3. Start with Docker (recommended)
```bash
npm run docker:up
```
Services:
- API:         http://localhost:3000
- Bull Board:  http://localhost:3001  (queue dashboard)
- MongoDB:     localhost:27017
- Redis:       localhost:6379

### 4. Start in development
```bash
# Terminal 1 — API server
npm run dev

# Terminal 2 — Background worker
npm run dev:worker
```

### 5. Create indexes (first time after loading data)
```bash
npm run indexes
```

---

## API Reference

### Backtest Jobs

| Method | Path | Description |
|--------|------|-------------|
| `POST`   | `/api/backtests` | Create & queue a backtest |
| `GET`    | `/api/backtests` | List jobs (paginated) |
| `GET`    | `/api/backtests/:jobId` | Job status + result |
| `GET`    | `/api/backtests/:jobId/result` | Result only (when completed) |
| `GET`    | `/api/backtests/:jobId/trades` | Paginated trade log |
| `DELETE` | `/api/backtests/:jobId` | Cancel or delete |
| `GET`    | `/api/backtests/queue` | Bull queue stats |

### Simulator

| Method | Path | Description |
|--------|------|-------------|
| `POST`   | `/api/simulator/sessions` | Start new session |
| `GET`    | `/api/simulator/sessions/:id` | Session state |
| `GET`    | `/api/simulator/sessions/:id/market` | Market snapshot at current candle |
| `GET`    | `/api/simulator/sessions/:id/candle` | Full candle + live P&L |
| `POST`   | `/api/simulator/sessions/:id/advance` | Step forward N candles |
| `POST`   | `/api/simulator/sessions/:id/jump` | Jump to datetime |
| `POST`   | `/api/simulator/sessions/:id/positions` | Open position |
| `DELETE` | `/api/simulator/sessions/:id/positions/:posId` | Close position |

### Market Data

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/market/candle` | Single candle |
| `GET` | `/api/market/chain` | Option chain at a candle |
| `GET` | `/api/market/candles` | Batch candles (max 31 days) |
| `GET` | `/api/market/expiries` | Expiry dates on a date |
| `GET` | `/api/market/available-days` | Trading calendar |
| `GET` | `/api/market/stats` | Collection stats |

### Strategy

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/strategy/templates` | List all 10 templates |
| `GET`  | `/api/strategy/templates/:key` | Template detail |
| `POST` | `/api/strategy/from-template` | Build config from template |
| `POST` | `/api/strategy/calculate-margin` | SPAN + Exposure margin |

---

## Strategy Configuration

### Leg definition

```typescript
{
  id: "leg-1",
  action: "BUY" | "SELL",
  optionType: "CE" | "PE",
  strikeSelection: {
    type: "atm_offset",  offset: 0         // ATM
    type: "atm_offset",  offset: 2         // ATM+2 strikes
    type: "delta",       targetDelta: 0.25 // closest to 25-delta
    type: "pct_otm",     pct: 2            // 2% OTM
    type: "fixed_strike",strike: 21700
  },
  expirySelection: {
    type: "nearest"
    type: "weekly",  weekOffset: 0   // current week
    type: "monthly", monthOffset: 0  // current monthly
    type: "fixed_expiry", date: "2024-01-25"
  },
  lots: 1
}
```

### Condition tree (from the Condition Builder)

The condition tree JSON from the frontend maps 1:1 to the backend `ConditionTree` type. Every field from the frontend (`cash.close`, `call.delta`, `vix.close`, `straddle_premium`, `time.days_to_expiry`, etc.) resolves directly. Nested AND/OR/NOT groups evaluate recursively.

### Risk rules

```typescript
{
  stopLossPct: 50,           // % of premium collected
  targetPct: 30,
  maxDailyLossPct: 3,        // % of total capital
  trailingStop: { enabled: true, trailPct: 25 },
  reEntry: { enabled: true, maxCount: 1 },
  ivFilter: { enabled: true, minIV: 10, maxIV: 25 },
  vixFilter: { enabled: true, maxVix: 20 }
}
```

---

## Backtest Flow

```
POST /api/backtests
  └─→ Persist BacktestJob (status: queued) in MongoDB
  └─→ Enqueue to Bull (Redis)
  └─→ Return { jobId, pollUrl } immediately

Bull Worker picks up job:
  └─→ fetchRawCandles() — queries option_chain_{instrument}_{year} collections
  └─→ processCandle() — computes ATM, greeks, PCR, max pain, IV skew per candle
  └─→ backtestEngine loop — candle by candle:
        ├─ evaluateConditionTree(entry) — entry conditions
        ├─ buildLegs() — resolve strikes by delta/offset/pct
        ├─ evaluateConditionTree(stopLoss/target/exit) — position management
        ├─ trailing stop, max daily loss, EOD close
        └─ compute PnL, equity curve, Greeks timeline
  └─→ computeSummary() — Sharpe, Sortino, Calmar, drawdown, win rate
  └─→ Save result to MongoDB (status: completed)

GET /api/backtests/:jobId  — poll for result
```

---

## Scaling Workers

```bash
# Scale workers with Docker Compose
docker-compose up --scale worker=5

# Or adjust BACKTEST_WORKER_CONCURRENCY in .env
BACKTEST_WORKER_CONCURRENCY=5
```

The API server (`BACKTEST_WORKER_CONCURRENCY=0`) does not process jobs — it only queues them. Workers connect to the same Redis queue independently.
