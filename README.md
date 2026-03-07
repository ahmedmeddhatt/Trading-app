# EGX Trading App — Backend API

A production-ready NestJS backend for real-time Egyptian stock exchange (EGX) data, portfolio management, and automated price archival.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS 11 + TypeScript |
| Database | PostgreSQL (Supabase) + Prisma ORM |
| Cache / Queue | Upstash Redis + BullMQ |
| Scraping | Playwright (EGXpilot + SimplyWallSt) |
| Logging | nestjs-pino (JSON → Loki-ready) |
| Auth | JWT + Google OAuth + Apple Sign-In |
| Container | Docker (multi-stage, Debian slim, non-root) |

---

## Architecture

```
POST /transactions
  └─ TransactionsModule
       └─ emit transaction.created
            └─ PositionsModule (listener) → recalculate position

Scraper (BullMQ)
  ├─ list-scraper   → every 24h  → EGXpilot stock list → Redis
  ├─ price-scraper  → every 30s  → EGXpilot live prices → Redis HSET + PubSub
  ├─ detail-scraper → on demand  → SimplyWallSt fundamentals → DB (stocks table)
  └─ archiver       → every 1h (market hours only)
       ├─ ensurePartitionExists(today)
       ├─ ensurePartitionExists(today + 30d)
       └─ HGETALL market:prices → createMany → stock_price_history (partitioned)

SSE Stream
  └─ Redis SUB prices channel → GET /api/prices?symbol=COMI → EventSource

Stocks Dashboard (GET /stocks/dashboard)
  ├─ HGETALL market:prices → hottest (top 5 |changePercent|) + lowest (top 5 by price)
  ├─ Prisma stocks (pe ASC) → recommended (top 5 by fundamentals)
  ├─ Redis cache 30s (cache:dashboard key)
  └─ positions by userId → myStocks (JWT optional)

Portfolio Analytics (GET /portfolio/:userId/analytics)
  ├─ positions + realizedGains from DB
  ├─ unrealizedPnL = (livePrice − avgPrice) × qty  [from Redis]
  └─ graphData from stock_price_history (per symbol)
```

---

## Database Schema

```
users               → id, email, passwordHash, googleId, appleId
transactions        → userId, symbol, type (BUY/SELL), quantity, price
positions           → userId, symbol, totalQuantity, averagePrice, totalInvested
realized_gains      → userId, symbol, quantity, sellPrice, avgPrice, profit
stocks              → symbol (PK), name, sector, marketCap, pe
stock_price_history → (id, timestamp) composite PK — PARTITION BY RANGE (timestamp)
  └─ stock_price_history_y2026_m02  (child partition, auto-routed by Postgres)
```

Self-healing partitions: `ArchiverProcessor` calls `ensurePartitionExists()` for the current month and 30 days ahead on every run.

---

## Environment Variables

```env
DATABASE_URL=postgresql://...          # Supabase connection string
REDIS_URL=rediss://...                 # Upstash (rediss:// enables TLS automatically)
JWT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=...
APPLE_CLIENT_ID=...
APPLE_TEAM_ID=...
APPLE_KEY_ID=...
APPLE_PRIVATE_KEY=...
PORT=3000
```

---

## Local Development

```bash
npm install
npm run dev          # watch mode
```

```bash
# Apply DB migrations
npx prisma migrate dev

# Open Prisma Studio
npx prisma studio

# Verify Upstash Redis connection
npx ts-node verify-redis.ts
```

---

## Docker

```bash
# Build and run
docker compose up --build

# Build image only
docker build -t trading-app .
docker run -p 3000:3000 --env-file .env trading-app
```

The image uses a 3-stage build (`deps → builder → runner`):
- `deps`: prod dependencies only (`--omit=dev --ignore-scripts`)
- `builder`: full install + `prisma generate` + `nest build`
- `runner`: Debian slim + system Chromium + non-root user (`nestjs:1001`)

---

## API Reference

### Auth
```
POST /auth/register     { email, password, name }
POST /auth/login        { email, password }
POST /auth/logout
GET  /auth/me
GET  /auth/google
GET  /auth/apple
```

### Users
```
GET  /users
GET  /users/:id
POST /users
```

### Transactions
```
POST /transactions      { userId, symbol, type, quantity, price }
GET  /transactions/user/:userId
```

### Positions & Portfolio
```
GET /positions/user/:userId
GET /positions/user/:userId/:symbol
GET /portfolio/:userId
GET /portfolio/:userId/analytics
```
Analytics response:
```json
{
  "positions": [{
    "symbol": "COMI",
    "totalQuantity": "10",
    "averagePrice": "130.00",
    "totalInvested": "1300.00",
    "currentPrice": 138,
    "lastPriceUpdate": "...",
    "unrealizedPnL": "80.00",
    "realizedPnL": "0.00",
    "graphData": [{ "price": "130", "timestamp": "..." }]
  }],
  "portfolioValue": {
    "totalInvested": "1300.00",
    "totalRealized": "0.00",
    "totalUnrealized": "80.00",
    "totalPnL": "80.00"
  }
}
```

### Stocks
```
GET /stocks/dashboard               # optional JWT for myStocks
GET /stocks?search=&sector=&minPE=&maxPE=&page=&limit=
```
Dashboard response:
```json
{
  "hottest":     [{ "symbol", "price", "changePercent", "lastUpdate" }],
  "recommended": [{ "symbol", "name", "sector", "marketCap", "pe", "price", "changePercent" }],
  "lowest":      [{ "symbol", "price", "changePercent", "lastUpdate" }],
  "myStocks":    [{ "symbol", "totalQuantity", "averagePrice", "totalInvested", "price" }]
}
```
- Dashboard cached in Redis for **30 seconds**
- `myStocks` populated only when authenticated (JWT cookie)

Search response: `{ data[], total, page, limit, pages }`

### Real-Time Prices (SSE)
```
GET /api/prices                 # all symbols
GET /api/prices?symbol=COMI     # single symbol
```
```ts
const es = new EventSource('/api/prices?symbol=COMI', { withCredentials: true });
es.onmessage = (e) => console.log(JSON.parse(e.data)); // { symbol, price, timestamp }
```

### Health
```
GET /health   →  { "success": true, "data": { "status": "ok", "timestamp": "..." } }
```

---

## Response Envelope

All endpoints return:
```json
{ "success": true, "data": { ... } }
{ "success": false, "message": "...", "statusCode": 400 }
```

---

## Verification Queries (Supabase SQL Editor)

```sql
-- Confirm partition exists and is receiving data
SELECT count(*) FROM "stock_price_history_y2026_m02";

-- List all active partitions
SELECT parent.relname, child.relname, pg_get_expr(child.relpartbound, child.oid)
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
WHERE parent.relname = 'stock_price_history';

-- Last archived price for a symbol
SELECT * FROM stock_price_history WHERE symbol = 'COMI' ORDER BY timestamp DESC LIMIT 1;
```

---

## Branch

Current: `portioning-tables` | Main: `master`
