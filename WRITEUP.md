# Write-Up

## The Atomic Decision

The core of this system comes down to one question: when 500 people try to grab seat A12 at the exact same moment, how do you make sure exactly one of them gets it?

A naive approach — check if the seat is free, then update it — falls apart instantly under concurrency. Between your SELECT and your UPDATE, someone else has already taken it. You've just double-sold a seat.

Here's what I did instead:

### Advisory Lock Per User+Show

Before anything else in the reserve transaction, I grab a Postgres advisory lock keyed on `hashtext(user_id || ':' || show_id)`:

```sql
SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))
```

This serializes all requests from the same user for the same show. It's what makes the per-user seat limit actually hold under concurrency without it, a user firing 10 parallel requests could slip past the limit check before any of them commit.

The lock is transaction-scoped (`pg_advisory_xact_lock`), so it auto-releases on commit or rollback. No cleanup needed.

### Row-Level Locking on Seats

After the advisory lock, the actual seat contention is handled with `SELECT ... FOR UPDATE`:

```sql
SELECT id, seat_number, status
FROM show_seats
WHERE show_id = $1 AND seat_number = ANY($2::text[])
ORDER BY seat_number ASC
FOR UPDATE
```

This locks the specific seat rows being requested. If two users are fighting over A12, one of them blocks until the other commits. The second user then sees `status = 'confirmed'` and gets a clean 409.

The `ORDER BY seat_number ASC` is deliberate, it prevents deadlocks in multi-seat requests. If user A wants `[A1, A3]` and user B wants `[A3, A1]`, they both lock in the same order (A1 first, then A3), so they can't deadlock each other.

### Why This Combination

The advisory lock and the row lock serve different purposes:
- **Advisory lock** protects the per-user limit. It ensures that counting a user's existing reservations and creating a new one happen atomically for that user.
- **Row lock** protects the seats themselves. It ensures that checking a seat's status and claiming it happen atomically for that seat.

You could technically do everything with just row locks, but then the per-user limit becomes a lot harder to enforce correctly under concurrency.

### The CHECK Constraint as a Safety Net

The `show_seats` table has a CHECK constraint:

```sql
CHECK (
  (status = 'available' AND reservation_id IS NULL) OR
  (status = 'confirmed' AND reservation_id IS NOT NULL)
)
```

This is the last line of defense. Even if there's a bug in the application logic, the database won't let a seat be in an inconsistent state. A seat can't be "confirmed" without a reservation attached, and an "available" seat can't have a stale reservation_id hanging around.

---

## Idempotency

### How It Works

Every reserve request carries an `idempotency_key` in the body. The system guarantees exactly-once processing for each key.

The key and its associated response are stored in the `idempotency_records` table:

```sql
CREATE TABLE idempotency_records (
  key VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  show_id UUID NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  response_status INT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Two-Layer Check

There's a subtle race condition with idempotency. If you only check in a middleware (before the transaction), two identical requests arriving at the same time can both pass the check, with 2nd request getting already booked error after request 1 has committed, which is incorrect user experience.

So I check in two places:

1. **Middleware pre-check** (`idempotency.ts`) — fast path. If the key exists, return the cached response immediately without touching the transaction machinery. This handles the common retry case cheaply.

2. **In-transaction re-check** (`shows.ts:69-80`) — inside the advisory-locked transaction, check again. If a concurrent request already committed with this key between the middleware check and the lock acquisition, we catch it here and replay the cached response.

The idempotency record is inserted inside the same transaction as the reservation, so they commit atomically. There's no window where a reservation exists but its idempotency record doesn't.

### Same Key, Different Body

When a request comes in with a known key, I hash the seat list and compare it against the stored hash:

```typescript
const requestHash = crypto.createHash('sha256')
  .update(requestedSeats)
  .digest('hex');
```

If the hash doesn't match, the client is trying to reuse a key with different seats. That's a 409 with reason `IDEMPOTENCY_MISMATCH`. This prevents a subtle class of bugs where a client retries but accidentally changes the payload.

## Observability

### What's Instrumented

- **`reservations_confirmed_total`** — counter. Goes up by 1 for every successful booking. If this flatlines during an on-sale event, something is very wrong.
- **`reservations_declined_total{reason="..."}`** — counter by reason. A spike in `SEAT_ALREADY_TAKEN` during the first few seconds is normal (hot seat contention). A spike in `LOCK_CONTENTION` means the DB is struggling.
- **`seats_available_current{show_id="..."}`** — gauge. Should monotonically decrease during an on-sale event (unless there are cancellations). If it jumps around or goes negative, we have a bug.
- **Structured logs** — every request gets a correlation ID (`x-request-id`). Pino outputs JSON in production, so you can pipe it into whatever log aggregator you're using.

## AI Usage

I used AI (Claude / Gemini) throughout this project — here's how:

**What AI decided (I reviewed and adjusted):**
- Initial project structure and boilerplate (Express setup, Dockerfile, docker-compose)
- First draft of the SQL schema
- Zod validation schemas
- The burst test script structure

**What I decided (AI helped implement):**
- The advisory lock + FOR UPDATE strategy. I knew I needed two levels of locking — one for user-level serialization, one for seat-level atomicity. AI helped with the specific Postgres syntax but the architecture was my call.
- Two-layer idempotency. Duplicate request from a user might bypass the middleware if first request has not committed yet.
- All-or-nothing semantics for multi-seat requests. I chose this over best-effort because partial bookings create a bad user experience for groups.
- Error handling strategy — converting deadlocks to 409s instead of 500s was a deliberate decision to keep the zero-5xx requirement achievable.

**What I'd extend:**
- Adding per-seat status detail to the GET endpoint
- Making the health check actually ping the database
- Supporting the idempotency key as a header (not just body)

---

## What I'd Do Next

Given more time, roughly in priority order:

1. **Readiness probe** — make the health endpoint run a quick `SELECT 1` against Postgres so it actually catches DB outages.
2. **Per-seat detail in GET /shows/{id}** — return each seat with its status, not just the aggregate counts.
3. **Idempotency key cleanup** — old keys pile up forever right now. A simple cron that deletes records older than 24h would fix that.
4. **Graceful shutdown** — catch SIGTERM, stop accepting new requests, let in-flight ones finish, then close the DB pool.
5. **Bump the connection pool** — 20 connections is fine for normal traffic but gets tight under a heavy burst. Would tune based on actual load numbers.
6. **Support idempotency key in header** — the spec says header or body, I only support body right now. Small change but worth doing for spec compliance.

