# Seat Reservation System

A high-concurrency seat reservation API built for the "on-sale stampede" scenario — thousands of users fighting over the same seats the moment a show goes live.

The whole point of this project is correctness under pressure. When 500 people try to grab seat A12 at the same time, exactly one of them gets it. Everyone else gets a clean "already taken" response. No double-sells, no 500s, no corrupted state.

**Live URL:** `https://seat-reservation-api-0srb.onrender.com`

---

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express 5
- **Database:** PostgreSQL 16
- **Observability:** Pino (structured logging), Prometheus client (metrics)
- **Validation:** Zod

## Quick Start

### With Docker (recommended)

```bash
git clone <repo-url> && cd seat-reservation-system

# Spin up API + Postgres
docker compose up --build

# In another terminal, initialize the database
docker compose exec api npx tsx src/db/init.ts
```

API is now running at `http://localhost:3000`.

### Without Docker

You'll need Node.js 20+ and a running PostgreSQL instance.

```bash
git clone <repo-url> && cd seat-reservation-system

npm install

# Set up your env
cp .env.sample .env
# Edit .env and set your DATABASE_URL

# Initialize the database
npm run db:init

# Start the dev server
npm run dev
```

---

## API Endpoints

### Create a Show (admin only)

```bash
curl -X POST http://localhost:3000/shows \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer admin_mytoken" \
  -d '{
    "name": "friday-night",
    "seats": ["A1","A2","A3","A4","A5"],
    "price_paise": 25000
  }'
```

Any token starting with `admin_` is treated as an admin. Everything else is a regular user.

### Reserve Seats

```bash
curl -X POST http://localhost:3000/shows/<show_id>/reserve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer user_alice" \
  -d '{
    "seats": ["A1", "A2"],
    "idempotency_key": "some-unique-key"
  }'
```

**Behaviour:**
- **All-or-nothing**: if you ask for `["A1", "A2"]` and A2 is taken, neither gets booked. No partial reservations.
- **Per-user limit**: defaults to 4 seats per show. Go over and you get a 409.
- **Idempotency**: retry with the same key and you get the original response back. Same key but different seats? 409.

### Cancel a Reservation

```bash
curl -X POST http://localhost:3000/reservations/<reservation_id>/cancel \
  -H "Authorization: Bearer user_alice"
```

Only the owner can cancel. Cancelled seats go back to available.

### Show State + Reconciliation

```bash
curl http://localhost:3000/shows/<show_id>
```

Returns seat counts by status and a reconciliation check:
```json
{
  "show": { "id": "...", "name": "friday-night", "price_paise": 25000 },
  "reconciliation": {
    "available": 3,
    "confirmed": 2,
    "total_seats": 5,
    "is_valid": true
  }
}
```

`available + confirmed == total_seats` must always hold. If `is_valid` is false, something went very wrong.

### Health

```
GET /health        → { "status": "ok" }
```

### Metrics (Prometheus)

```
GET /metrics
```

Exposes:
- `reservations_confirmed_total` — how many bookings went through
- `reservations_declined_total{reason="..."}` — broken down by reason (SEAT_ALREADY_TAKEN, USER_LIMIT_EXCEEDED, IDEMPOTENCY_MISMATCH)
- `seats_available_current{show_id="..."}` — live gauge of available seats per show

---

## Running the Burst Test

This is the stampede simulator. It creates a show, then fires a mix of concurrent requests — hot seat contention, quota bypass attempts, idempotency replays, and random load.

```bash
# Against local
BASE_URL=http://localhost:3000 npm run test:burst

# Against deployed
BASE_URL=https://seat-reservation-api-0srb.onrender.com npm run test:burst
```

The burst script defaults are configurable via environment variables:

| Variable | Default | What it does |
|---|---|---|
| `BURST_TOTAL_ROWS` | 10 | Number of seat rows (A-J) |
| `BURST_SEATS_PER_ROW` | 10 | Seats per row (1-10) |
| `BURST_HOT_SEAT_USERS` | 20 | Users fighting over seat A1 |
| `BURST_QUOTA_USER_REQUESTS` | 100 | Parallel requests from one greedy user |
| `BURST_RANDOM_USERS` | 20000 | Random users making random bookings |

The script prints an outcome distribution table and the final reconciliation state. A passing run looks like:

```
┌────────────────────────────────────┬────────┐
│ 201 (New Reservation)              │   47   │
│ 201 (Cached Replay)               │    4   │
│ 409 (Seat Taken)                   │   85   │
│ 409 (Limit Exceeded)              │   96   │
│ 409 (Idempotency Mismatch)        │    1   │
│ 5xx (Server Error)                │    0   │ ← must be zero
└────────────────────────────────────┴────────┘
Reconciliation: is_valid = true                 ← must be true
```

### What the burst tests cover

1. **Hot seat storm** — N users all grab the same seat. Exactly one wins.
2. **Quota bypass** — one user fires 10+ parallel reservations on a limit-4 show. Should end up with at most 4.
3. **Idempotent retries** — same key, same seats, 5 times. One real reservation, rest are cache hits.
4. **Idempotency mismatch** — same key, different seats. Gets a 409.
5. **Multi-seat rollback** — asks for two seats where one is already taken. Gets rejected cleanly, no half-booking.
6. **Non-existent seats** — tries to book Z99. Gets a 400.
7. **Random load** — background noise of legitimate bookings.

---

## Authentication

This is a simplified token-based auth for the exercise — no JWT signing or verification. The Bearer token *is* the user identity.

- Token `admin_anything` → admin role
- Token `anything_else` → regular user
- The user ID is the token itself, so identity always comes from the auth header, never the request body

---

## Project Structure

```
src/
├── server.ts              # Express app setup, middleware chain
├── types.ts               # Request type extensions
├── schemas.ts             # Zod validation schemas
├── constants/
│   └── enums.ts           # Status enums (seat, reservation)
├── db/
│   ├── index.ts           # Connection pool setup
│   ├── init.ts            # Schema migration runner
│   └── schema.sql         # Table definitions, constraints, indexes
├── middlewares/
│   ├── auth.ts            # Token extraction, admin check
│   ├── errorHandler.ts    # Deadlock/validation/500 handler
│   └── idempotency.ts     # Idempotency key pre-check
├── routes/
│   ├── shows.ts           # Create show, reserve seats, show state
│   └── reservations.ts    # Cancel reservation
├── scripts/
│   └── burst.ts           # Concurrency burst test
└── utils/
    ├── logger.ts          # Pino logger setup
    └── metrics.ts         # Prometheus counters and gauges
```

---

## Known Limitations & What I'd Do Next

- The health endpoint is a basic liveness check — a proper readiness probe would verify the DB connection is alive.
- No hold/expiry mechanism — seats go straight to confirmed. A real ticketing system would use time-boxed holds with a background sweeper.
- Idempotency keys live forever. In production I'd add a TTL and a cleanup job.
- Connection pool size (20) is tight for very large bursts. Would tune based on actual load testing.
