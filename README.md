# Trading App — Backend API

NestJS + Supabase PostgreSQL + Upstash Redis + BullMQ

---

## Stack

| Layer | Tech |
|---|---|
| Framework | NestJS (modular monolith, event-driven) |
| ORM | Prisma 5.22 (requires Node ≥ 20.15, < 20.19) |
| Database | Supabase PostgreSQL |
| Cache / Pub-Sub | Upstash Redis (TLS `rediss://`) |
| Job Queues | BullMQ → local Redis (`redis://`) |
| Events | `@nestjs/event-emitter` |
| Auth | JWT (httpOnly cookie) + Google OAuth + Apple OAuth |
| Scraper | EGXpilot HTTP API + SimplyWallSt (Playwright, detail only) |

---

## Setup

```bash
npm install

# copy and fill in env values
cp .env.example .env

# generate Prisma client + run migrations
npx prisma generate
npx prisma migrate dev

# start dev server
npm run dev
```

---

## Local Development (Docker)

A `docker-compose.yml` is included for running a local Postgres instance when Supabase is unavailable.

```bash
# start local Postgres on port 5433
docker compose up -d

# use local DB (override DATABASE_URL in .env)
DATABASE_URL="postgresql://trading:trading@localhost:5433/trading_dev"
DIRECT_URL="postgresql://trading:trading@localhost:5433/trading_dev"
```

> Local Redis must already be running on port 6379 for BullMQ queues.

---

## Environment Variables

```env
# Supabase — transaction pooler (runtime queries)
DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true"

# Supabase — session pooler (migrations / schema changes)
DIRECT_URL="postgresql://postgres.<ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres"

# Auth
JWT_SECRET=<strong-random-secret>
JWT_EXPIRES_IN=7d

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# Apple OAuth
APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY_PATH=./secrets/AuthKey.p8
APPLE_CALLBACK_URL=http://localhost:3000/auth/apple/callback

# Upstash Redis — SSE price stream + stock data cache (must use rediss://)
UPSTASH_REDIS_URL=rediss://default:<token>@<host>.upstash.io:6379

# Local Redis — BullMQ queues (must be separate from Upstash)
BULL_REDIS_URL=redis://localhost:6379

FRONTEND_URL=http://localhost:3000
```

> **Special chars in password:** URL-encode them — `@` → `%40`

---

## API Endpoints

### Auth
| Method | Path | Guard | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Register `{ email, name, password }` → sets cookie |
| POST | `/auth/login` | — | Login `{ email, password }` → sets cookie |
| POST | `/auth/logout` | — | Clears `access_token` cookie |
| GET | `/auth/me` | JWT | Returns current user |
| GET | `/auth/google` | — | Redirects to Google OAuth |
| GET | `/auth/google/callback` | — | Google OAuth callback |
| GET | `/auth/apple` | — | Redirects to Apple OAuth |
| POST | `/auth/apple/callback` | — | Apple OAuth callback |

### Users
| Method | Path | Description |
|---|---|---|
| GET | `/users` | List all users (passwordHash stripped) |
| POST | `/users` | Create user `{ email, name, password? }` |
| GET | `/users/:id` | Get user by ID |

### Health
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/health` | — | App status + `{ isOpen, label, nextOpenMs }` market status |

### Transactions
| Method | Path | Description |
|---|---|---|
| POST | `/transactions` | `{ userId, symbol, type: BUY\|SELL, quantity, price, fees? }` |
| GET | `/transactions/user/:userId` | Transaction history (newest first) |

### Positions
| Method | Path | Description |
|---|---|---|
| GET | `/positions/user/:userId` | All open positions |
| GET | `/positions/user/:userId/:symbol` | Single position |

### Portfolio
| Method | Path | Query Params | Description |
|---|---|---|---|
| GET | `/portfolio/:userId` | — | Summary: total invested + positions |
| GET | `/portfolio/:userId/analytics` | — | P&L, fees, netPnL, bestDay, worstDay, avgHoldingDays, symbolsTraded |
| GET | `/portfolio/:userId/timeline` | `from`, `to` (ISO dates) | Running portfolio value over time |
| GET | `/portfolio/:userId/allocation` | — | Holdings split by sector and by symbol (with %) |
| GET | `/portfolio/:userId/stock/:symbol/history` | — | Per-transaction runningQty/avgPrice + summary with unrealizedPnL |

### Stocks
| Method | Path | Query Params | Description |
|---|---|---|---|
| GET | `/stocks/dashboard` | — | All stocks with live prices from Redis |
| GET | `/stocks` | `search`, `sector`, `minPE`, `maxPE`, `limit`, `page` | Filterable paginated stock list with live prices |
| GET | `/stocks/:symbol` | — | Detail: price, changePercent, priceHistory (30d), recommendation, signals |
| GET | `/stocks/:symbol/history` | — | Raw price history from `stock_price_history` table |

### Prices (SSE)
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/api/prices` | JWT | Live price stream. Optional `?symbol=AMOC` |

---

## Architecture

### Event Flow
```
POST /transactions
  → persist to DB
  → emit transaction.created
  → PositionsListener → recalculate position (prisma.$transaction)
```

### Scraper Flow
```
ScraperService (setInterval, checks every 60s)
  ├─ list-scraper queue  (every 24h + boot)
  │    → EgxpilotApiService.fetchAllStocks()   (HTTP API, retry + backoff)
  │    → saves market:list to Redis
  │    → upserts stocks table in DB
  │    └─ enqueues detail-scraper job
  │
  ├─ price-scraper queue  (market-hours-aware interval)
  │    Open 10:00–14:30   → every 30s
  │    Pre-market 09–10   → every 5min
  │    Post-market 14:30–17 → every 15min
  │    Closed / weekend   → every 2h
  │    → writes market:prices hash (price, changePercent, recommendation, signals)
  │    └─ publishes to prices channel → SSE clients
  │
  └─ detail-scraper queue
       → SimplyWallSt via Playwright
       └─ saves fundamentals to Redis
```

---

## Database Schema

| Table | Description |
|---|---|
| `users` | email/password + Google/Apple OAuth IDs |
| `transactions` | BUY/SELL records per user + symbol + `fees` |
| `positions` | Aggregated holdings; `averagePrice` includes fees in cost basis |
| `realized_gains` | Profit records on position close; profit net of sell fees |
| `stocks` | EGX master data: symbol, name, sector |
| `stock_price_history` | Historical price snapshots per symbol |

> Migration: `npx prisma migrate dev --name add_fees_to_transactions`

---

## Key Notes

- `PrismaModule` is `@Global()` — no need to import it in feature modules
- Financial fields use `Decimal(18,8)` — all math via `.add()/.sub()/.mul()/.div()`
- `EgxpilotApiService` tries direct API first (with retry + backoff), falls back to allorigins proxy
- Playwright used **only** in `detail-scraper` — EGXpilot uses plain HTTP
- `BULL_REDIS_URL` and `UPSTASH_REDIS_URL` **must** point to different Redis instances
- Price scraper is market-hours-aware (Cairo UTC+2, Sun–Thu); no fixed repeat job
- `fees` default `0` — Egyptian brokerage ~0.175% of trade value (`qty × price × 0.00175`)
- App starts even when DB is unreachable — connection errors are logged, not thrown
- Portfolio routes (analytics, timeline, allocation) must be declared **before** `/:userId` in the controller to avoid route conflicts

## Scripts

```bash
npm run dev           # hot-reload dev server
npm run start:prod    # production
npm run build         # compile TypeScript
npm run test          # unit tests
npm run test:e2e      # e2e tests
npm run test:cov      # coverage report
npx prisma studio     # browse DB in browser
npx prisma migrate dev --name <name>   # create + apply migration
```
