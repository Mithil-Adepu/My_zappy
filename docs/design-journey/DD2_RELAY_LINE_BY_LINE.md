# Deep Dive 2 — The Relay Daemon: Every Line Explained

> The relay is the bridge between Postgres and Kafka. It is a pure background process —
> no user-facing HTTP routes, just a poll loop. This document explains every design
> decision in `apps/relay`, why the Transactional Outbox pattern exists, and exactly
> how the `SELECT ... FOR UPDATE SKIP LOCKED` mechanism works.

---

## Table of Contents

1. [Why the Relay Exists](#1-why-the-relay-exists)
2. [`relay/src/main.ts` — Process Bootstrap and Graceful Shutdown](#2-relaysrcmaints--process-bootstrap-and-graceful-shutdown)
3. [`relay/src/poller/outbox-poller.ts` — The Core Poll Loop](#3-relaysrcpolleroutbox-pollerts--the-core-poll-loop)
4. [The Transactional Outbox Pattern: A First-Principles Explanation](#4-the-transactional-outbox-pattern-a-first-principles-explanation)
5. [`SELECT ... FOR UPDATE OF o SKIP LOCKED`: How It Works](#5-select--for-update-of-o-skip-locked-how-it-works)
6. [The Optimistic Claim Pattern](#6-the-optimistic-claim-pattern)
7. [Dead-Letter Handling and Retry Semantics](#7-dead-letter-handling-and-retry-semantics)
8. [Kafka Producer: Blast Radius Isolation via Partition Keys](#8-kafka-producer-blast-radius-isolation-via-partition-keys)

---

## 1. Why the Relay Exists

Consider the naive alternative: inside `hooks-api`'s webhook handler, after writing to
`webhook_events`, directly publish a message to Kafka:

```typescript
// DANGEROUS — DO NOT DO THIS
await prisma.webhookEvent.create({ ... });
await kafkaProducer.send({ topic: 'zap.run.requested', messages: [...] });
```

**What happens when this fails?**

- Scenario A: The DB write succeeds, but Kafka is momentarily down. The event is in the DB but
  no message is published. The worker never knows the event exists. **The event is lost forever.**

- Scenario B: The DB write succeeds, Kafka write succeeds, but then the process crashes before
  responding to GitHub. GitHub retries. The second delivery creates another `webhook_events` row
  (we have `ON CONFLICT DO NOTHING`), but also publishes a second Kafka message. **The event is
  executed twice.** If the action is "charge customer", this is catastrophic.

- Scenario C: The Kafka write fails with a transient error. We retry in the same HTTP handler.
  The handler now holds a DB transaction open for 30+ seconds while retrying Kafka. During this
  time, the `webhook_events` row is locked. GitHub's 10-second timeout fires. GitHub retries,
  hits the locked row, and blocks. **Cascading deadlock.**

All three scenarios are real bugs in production systems built without the Outbox pattern.

**The Outbox solution:** Write to `webhook_events` and `outbox` in the same atomic DB transaction.
Then, a separate daemon (relay) reads the outbox and publishes to Kafka. If Kafka is down, the
relay simply waits and retries. The DB is the source of truth. Kafka is a derived, best-effort
delivery mechanism.

---

## 2. `relay/src/main.ts` — Process Bootstrap and Graceful Shutdown

**File:** `apps/relay/src/main.ts`

### Lines 1–7: Imports

```typescript
import express from 'express';
import { env } from './config/env';
import { initSentry } from './lib/sentry';
import { pollOutbox, requestStop } from './poller/outbox-poller';
import { disconnectProducer } from './kafka/producer';
import { prisma } from '@zapier-clone/db';
import { logger } from './lib/logger';
```

The relay imports Express not for user-facing routes, but for exactly one thing: a `/health`
endpoint. Docker Compose and Kubernetes use HTTP health checks to determine if a container is
healthy. Without `/health`, the orchestrator would assume the relay is always healthy even if
Postgres is unreachable.

### Lines 9–10: Sentry first

```typescript
initSentry();
```

Same rule as `hooks-api` — Sentry patches Node internals and must run before anything else.

### Lines 13–24: Minimal Express app (health only)

```typescript
const app = express();

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true });
  } catch (err) {
    logger.error({ err }, '[relay] Health check failed');
    res.status(503).json({ status: 'error', db: false });
  }
});
```

The relay has **no other HTTP surface**. It's a pure background process. The Express server exists
solely for this health endpoint. There are no routes for creating zaps, no auth endpoints —
nothing that a user would ever call. If you removed Express and `app.listen()`, the only way to
know the relay is alive would be through its log output, which is not machine-readable by Docker.

### Lines 26–55: Graceful Shutdown

```typescript
let currentPollPromise: Promise<void> | null = null;

process.on('SIGTERM', async () => {
  logger.info('[relay] SIGTERM received — finishing in-flight poll before exit');
  requestStop();

  if (currentPollPromise) {
    await currentPollPromise;
  }

  await disconnectProducer();
  await prisma.$disconnect();
  logger.info('[relay] Shutdown complete');
  process.exit(0);
});
```

**Why graceful shutdown matters for the relay:**

The poll loop is not instantaneous. At any given moment, the relay may be in the middle of:
- A Postgres transaction (claiming rows, marking dispatched)
- A Kafka produce call (waiting for broker ack)

If we `SIGKILL` mid-transaction, the Postgres transaction auto-rollbacks (Postgres detects the
TCP disconnect and releases locks). That's safe — the outbox rows go back to `pending`. But if
we're between the transaction commit (rows marked `dispatched`) and the Kafka produce call, those
rows stay `dispatched` forever. The `recover-dispatched-outbox.job.ts` cron job (covered in DD4)
handles this case by resetting stuck `dispatched` rows to `pending`.

**`requestStop()`** — sets a module-level boolean `stopRequested = true` in the poller. The poll
loop checks this flag on each iteration and exits when it's set.

**`await currentPollPromise`** — waits for the currently in-flight poll iteration to finish
before exiting. This ensures we don't abort mid-transaction.

**`disconnectProducer()`** — flushes any pending Kafka messages and closes the TCP connection to
the broker. Without this, in-flight Kafka produce calls would be aborted, potentially losing
already-claimed outbox rows that haven't produced yet.

**`process.exit(0)`** — explicit exit code 0 = clean shutdown. Docker recognizes this and does
NOT restart the container. A `process.exit(1)` would cause Docker to restart.

### Lines 58–66: Start

```typescript
const PORT = env.RELAY_HEALTH_PORT;

app.listen(PORT, () => {
  logger.info({ port: PORT }, '🔁  relay health endpoint started');
});

logger.info('🔁  relay starting outbox poll loop...');
currentPollPromise = pollOutbox();
```

`pollOutbox()` is an infinite `while (true)` loop. Assigning it to `currentPollPromise` allows
the SIGTERM handler to `await` it. Notice we do NOT `await` it here — that would block the event
loop. We store the promise and let the event loop run the poll loop asynchronously alongside the
Express HTTP server.

---

## 3. `relay/src/poller/outbox-poller.ts` — The Core Poll Loop

**File:** `apps/relay/src/poller/outbox-poller.ts`

### Lines 7–17: OutboxRow interface

```typescript
interface OutboxRow {
  id: bigint;
  webhookEventId: bigint;
  eventId: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  // joined from webhook_events
  zapId: bigint;
  userId: bigint;
}
```

This interface defines what we expect back from the raw SQL query. Note that `zapId` and `userId`
are not on the `outbox` table itself — they come from `JOIN webhook_events we JOIN zaps z`.
This is why we use raw SQL rather than Prisma's ORM query: Prisma doesn't support arbitrary
multi-table joins with aliased columns in its find API.

### Lines 19–20: Module-level state

```typescript
let isRunning = false;
let stopRequested = false;
```

**`isRunning`** — prevents two poll loops from running simultaneously. If `pollOutbox()` is called
twice (shouldn't happen, but defensive), the second call returns immediately.

**`stopRequested`** — the graceful shutdown flag. Set by `requestStop()`, checked by the poll
loop.

### Lines 32–34: Re-entrancy guard

```typescript
export async function pollOutbox(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
```

**Why?** If the relay is restarted while already running (e.g., during a hot reload), this guard
prevents two poll loops from fighting each other over the same outbox rows.

### Lines 36–90: The main while loop

```typescript
while (!stopRequested) {
  try {
    const claimedRows = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT
          o.id,
          o.webhook_event_id AS "webhookEventId",
          o.event_id AS "eventId",
          o.payload,
          o.attempts,
          o.max_attempts AS "maxAttempts",
          we.zap_id AS "zapId",
          z.user_id AS "userId"
        FROM outbox o
        JOIN webhook_events we ON we.id = o.webhook_event_id
        JOIN zaps z ON z.id = we.zap_id
        WHERE o.status = 'pending'
        ORDER BY o.created_at ASC
        LIMIT ${env.RELAY_BATCH_SIZE}
        FOR UPDATE OF o SKIP LOCKED
      `;
```

**Anatomy of this SQL query:**

- `WHERE o.status = 'pending'` — only pick up rows that haven't been dispatched yet. Rows in
  `dispatched`, `consumed`, or `dead` states are skipped.

- `ORDER BY o.created_at ASC` — FIFO order within the `pending` set. Oldest events are processed
  first, providing fairness.

- `LIMIT ${env.RELAY_BATCH_SIZE}` — configurable (default: 10). Processes at most 10 rows per
  poll cycle. This bounds the amount of work per transaction and allows multiple relay instances
  to share the work.

- `FOR UPDATE OF o SKIP LOCKED` — the distributed locking mechanism. See Section 5 for full
  explanation.

The JOINs with `webhook_events` and `zaps` are necessary because the outbox table doesn't store
`zap_id` or `user_id` directly. These are needed to:
  - Build the Kafka message (`zapId` and `userId` are payload fields in `ZapRunRequestedEvent`).
  - Partition the Kafka message by `user_id` (blast radius isolation).

```typescript
      if (rows.length === 0) return [];

      // Optimistically mark as dispatched inside the transaction
      const ids = rows.map((r) => r.id);
      await tx.$executeRaw`
        UPDATE outbox
        SET status = 'dispatched', attempts = attempts + 1
        WHERE id = ANY(${ids}::bigint[])
      `;

      return rows;
    });
```

**Why mark `dispatched` inside the transaction?** The `FOR UPDATE` lock is held for the duration
of the transaction. By updating `status = 'dispatched'` before the transaction commits, we ensure
that:

1. When the transaction commits, the rows are atomically removed from the `pending` set.
2. Any other relay instance running the same `FOR UPDATE SKIP LOCKED` query will not see these
   rows as candidates (they're now `dispatched`, not `pending`).

**`attempts = attempts + 1`** — increments the attempt counter atomically. Even if the Kafka
produce call later fails and we revert to `pending`, the `attempts` counter has been bumped.
After `maxAttempts` failures, the row is moved to `dead`.

**`WHERE id = ANY(${ids}::bigint[])`** — PostgreSQL array operator. Updates all claimed row IDs
in a single query instead of N separate UPDATE statements. The cast `::bigint[]` ensures Postgres
treats the array as bigint (matching the `outbox.id` column type).

### Lines 77–80: Produce outside the transaction

```typescript
    // Use allSettled so a single row failure never aborts the rest of the batch
    await Promise.allSettled(claimedRows.map((row) => produceRow(row)));
```

**`Promise.allSettled` vs `Promise.all`:**

- `Promise.all` — rejects as soon as any promise rejects (fail-fast). If Kafka fails for one
  row, all other rows in the batch are abandoned.
- `Promise.allSettled` — waits for ALL promises to settle (fulfilled or rejected), collects all
  results. If one row fails, the others continue. Each `produceRow` handles its own error
  internally.

This design ensures that one bad outbox row (e.g., malformed payload that causes a serialization
error) does not block the entire batch. Other rows continue to be dispatched normally.

### Lines 85–86: Sleep between sweeps

```typescript
    await sleep(env.RELAY_POLL_INTERVAL_MS);
```

**Why sleep?** Without a sleep, the loop would poll at maximum CPU speed — thousands of times per
second when the outbox is empty. This would:
1. Hammer the Postgres connection pool with empty SELECT queries.
2. Saturate the relay container's CPU.
3. Create unnecessary I/O on the DB server.

`RELAY_POLL_INTERVAL_MS` (default: 1000ms) means the relay checks the outbox once per second.
For a Zapier clone, 1-second latency between webhook receipt and Kafka dispatch is completely
acceptable. Users don't expect real-time in < 1 second.

### Lines 93–140: `produceRow` — The Per-Row Kafka Dispatch

```typescript
async function produceRow(row: OutboxRow): Promise<void> {
  const producer = await getProducer();

  const event: ZapRunRequestedEvent = {
    webhookEventId: row.webhookEventId.toString(),
    zapId: row.zapId.toString(),
    userId: row.userId.toString(),
    payload: row.payload as Record<string, unknown>,
    receivedAt: new Date().toISOString(),
  };
```

**Why `toString()` on BigInt fields?** `ZapRunRequestedEvent` is defined in `@zapier-clone/types`
with string fields for IDs. JSON can't serialize native `bigint` (JSON has no bigint type). By
converting to `string`, we preserve the full 64-bit precision in the JSON message. The worker
converts them back to `BigInt` when reading.

**`receivedAt: new Date().toISOString()`** — the timestamp of when the relay dispatched the event.
This is different from the webhook's arrival time. Useful for measuring relay latency in logs.

```typescript
  try {
    await producer.send({
      topic: env.KAFKA_TOPIC_ZAP_RUN_REQUESTED,
      messages: [
        {
          // Partition key = user_id — bounds blast radius per tenant
          key: row.userId.toString(),
          value: JSON.stringify(event),
        },
      ],
    });

    logger.info({ outboxRowId: row.id.toString(), eventId: row.eventId }, '[relay] Dispatched outbox row');
  } catch (err) {
    logger.error({ err, outboxRowId: row.id.toString() }, '[relay] Failed to produce to Kafka — reverting status');

    // Row was already marked dispatched in the transaction; revert on Kafka failure
    const newAttempts = row.attempts + 1;
    if (newAttempts >= row.maxAttempts) {
      // Dead-letter — requires manual intervention
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: 'dead', attempts: newAttempts },
      });
    } else {
      // Revert to pending so next sweep retries
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: 'pending', attempts: newAttempts },
      });
    }
  }
}
```

**The error handling dance:** The row was already marked `dispatched` by the DB transaction (which
committed). If Kafka produce fails, we must revert the outbox row so the next poll sweep can retry
it. We update directly using Prisma (outside any transaction — this is a single-row update).

**Dead-lettering:** `row.attempts + 1 >= row.maxAttempts` (default maxAttempts = 5) — after 5
failed attempts, the row is marked `dead`. `dead` rows are not picked up by the poll loop (only
`pending` rows are). They require manual investigation and re-triggering. The
`stuck-outbox-alert.job.ts` cron (in app-api) sends Sentry alerts when `dead` rows exist.

---

## 4. The Transactional Outbox Pattern: A First-Principles Explanation

The fundamental problem: **you cannot atomically write to two different systems** (Postgres and
Kafka) without distributed transactions (2PC), and 2PC is expensive, complex, and Kafka doesn't
support it.

**The outbox pattern solves this by making Postgres the single source of truth:**

```
Phase 1: HTTP handler (hooks-api)
  BEGIN TRANSACTION
    INSERT INTO webhook_events (...)
    INSERT INTO outbox (status = 'pending', ...)
  COMMIT
  → Both writes succeed or both fail (atomic)
  → HTTP handler returns 200

Phase 2: Background process (relay)
  SELECT FROM outbox WHERE status = 'pending' FOR UPDATE SKIP LOCKED
  UPDATE outbox SET status = 'dispatched'
  COMMIT
  → Kafka produce(event)
  → If succeed: outbox row stays 'dispatched' (worker will mark 'consumed')
  → If fail: UPDATE outbox SET status = 'pending' (retry next sweep)
```

**Key properties:**
- The HTTP handler never touches Kafka. It writes only to Postgres.
- The relay decouples Kafka publishing from webhook ingestion.
- If Kafka is down for an hour, all webhooks accumulate in the outbox. When Kafka recovers,
  the relay drains the backlog without any manual intervention.
- If the relay crashes mid-dispatch, the `recover-dispatched-outbox.job.ts` cron resets stuck
  `dispatched` rows to `pending` within 15 minutes.

**The trade-off:** Eventual consistency. Between webhook arrival and Kafka publish, there's a
delay of up to `RELAY_POLL_INTERVAL_MS` (1 second) + Kafka round-trip. For an automation
platform, this is completely acceptable.

---

## 5. `SELECT ... FOR UPDATE OF o SKIP LOCKED`: How It Works

This SQL clause is the foundation of the relay's concurrency safety. Let's dissect it:

```sql
SELECT o.id, ... FROM outbox o
JOIN webhook_events we ON we.id = o.webhook_event_id
JOIN zaps z ON z.id = we.zap_id
WHERE o.status = 'pending'
ORDER BY o.created_at ASC
LIMIT 10
FOR UPDATE OF o SKIP LOCKED
```

**`FOR UPDATE`** — acquires a row-level write lock on each selected row. Other transactions that
try to `SELECT ... FOR UPDATE` the same rows will block (wait) until the lock is released.

**`OF o`** — restricts locking to only the `outbox` table (`o`). Without this qualifier, Postgres
would also try to lock rows in `webhook_events` and `zaps` (joined tables). Locking joined rows is
unnecessary and creates wider lock contention.

**`SKIP LOCKED`** — instead of blocking when a row is already locked, **silently skip it and move
to the next unlocked row**. This is the key to multi-instance concurrency.

**Without `SKIP LOCKED` (what happens):**
```
Relay instance A: SELECT ... FOR UPDATE → locks rows 1, 2, 3
Relay instance B: SELECT ... FOR UPDATE → BLOCKS, waits for A to release locks
→ Both instances serialize: B processes after A, wasting B's capacity.
```

**With `SKIP LOCKED`:**
```
Relay instance A: SELECT ... FOR UPDATE SKIP LOCKED → locks rows 1, 2, 3
Relay instance B: SELECT ... FOR UPDATE SKIP LOCKED → skips rows 1, 2, 3
                                                       → locks rows 4, 5, 6
→ Both instances work in parallel on non-overlapping row sets.
```

**The lock duration:** The `FOR UPDATE` lock is held for the duration of the Postgres transaction.
In our code, the transaction runs the SELECT, then the UPDATE (marking `dispatched`), then
commits. Lock duration is the time to execute those two SQL statements — typically < 10ms. After
commit, the lock is released.

**`FOR UPDATE` vs `SELECT FOR SHARE`:** `FOR SHARE` allows concurrent reads but prevents writes.
`FOR UPDATE` prevents both reads and writes by other locking transactions. We use `FOR UPDATE`
because we're about to UPDATE the rows — a shared read lock is insufficient.

---

## 6. The Optimistic Claim Pattern

The relay uses what we call the **Optimistic Claim** pattern:

```
Inside transaction:
  1. SELECT rows WHERE status = 'pending' FOR UPDATE SKIP LOCKED
  2. UPDATE rows SET status = 'dispatched'
  3. COMMIT (lock released)

Outside transaction:
  4. Kafka produce(row)
  5a. If success: leave row as 'dispatched' (worker will consume it)
  5b. If failure: UPDATE row SET status = 'pending' (revert)
```

**Why "optimistic"?** We optimistically assume Kafka will succeed and mark rows `dispatched` before
producing. This minimizes lock-hold time: the Postgres lock is held only for steps 1-3 (< 10ms),
not for the entire Kafka round-trip (potentially 100ms+). If we held the lock until Kafka
produced, concurrent relay instances would be blocked for much longer.

**The race condition:** What if the relay crashes between step 3 (commit) and step 4 (Kafka
produce)? The row stays `dispatched` forever. This is why `recover-dispatched-outbox.job.ts`
exists — it finds rows stuck at `dispatched` for > 15 minutes and resets them to `pending`.

---

## 7. Dead-Letter Handling and Retry Semantics

```typescript
const newAttempts = row.attempts + 1;
if (newAttempts >= row.maxAttempts) {
  await prisma.outbox.update({
    where: { id: row.id },
    data: { status: 'dead', attempts: newAttempts },
  });
} else {
  await prisma.outbox.update({
    where: { id: row.id },
    data: { status: 'pending', attempts: newAttempts },
  });
}
```

**Retry attempt tracking:**

The `attempts` column starts at 0. Each time the relay claims a row (`UPDATE SET status =
'dispatched', attempts = attempts + 1`), the counter is bumped inside the transaction. If Kafka
produce fails, we bump it again in the error handler.

Wait — `attempts` gets bumped twice for a failed produce? Let's trace:

```
Initial state: attempts = 0, status = 'pending'

Poll cycle 1:
  - Transaction: attempts = 0 + 1 = 1, status = 'dispatched'  ← bumped in TX
  - Kafka produce fails
  - Error handler: newAttempts = row.attempts + 1 = 0 + 1 = 1  ← (row.attempts was 0 before TX)
```

Wait — `row.attempts` in `produceRow` is the value at the time of SELECT, before the transaction
incremented it. So `row.attempts = 0`, `newAttempts = 0 + 1 = 1`. The update sets `attempts = 1`.
Combined with the transaction's bump, the final `attempts` value is 1. This is correct.

Actually looking more carefully: the transaction sets `attempts = attempts + 1` using SQL (server-
side arithmetic). The `row.attempts` variable in Go is the pre-transaction value (0). The error
handler sets `attempts = newAttempts = row.attempts + 1 = 1`. So the final DB value after error
handling is `1`. Correct — the transaction's SQL-side bump (`attempts = attempts + 1`) is
overwritten by the error handler's explicit `attempts: newAttempts`.

**Dead-letter state:** A row in `dead` status is permanently out of the relay's retry loop. It
requires manual investigation:
1. Check the row in the outbox table.
2. Check `stuck-outbox-alert.job.ts` Sentry alerts for context.
3. After fixing the underlying issue (Kafka topic missing, auth failure, etc.), manually reset
   `status = 'pending'` and `attempts = 0`.

---

## 8. Kafka Producer: Blast Radius Isolation via Partition Keys

```typescript
messages: [
  {
    key: row.userId.toString(),  // Partition key
    value: JSON.stringify(event),
  },
],
```

**Why partition by `user_id`?** Kafka distributes messages across partitions. All messages with
the same key go to the same partition. The worker's consumer group reads from partitions in
parallel.

**The blast radius problem:** Without partitioning by `user_id`, imagine user A has 10,000
webhooks arrive simultaneously (they just launched a product). These 10,000 messages are spread
across all partitions. Each consumer worker instance gets some. User B's single webhook might
land in the same partition as some of User A's 10,000 messages and sit in queue behind them.

**With `user_id` partitioning:**
```
Partition 0: [User A msg 1, User A msg 2, ..., User A msg 10000]
Partition 1: [User B msg 1]
Partition 2: [User C msg 1, User C msg 2]
```

User B's message is in a separate partition (Partition 1) and is processed independently of
User A's flood. User B's automation runs without delay regardless of User A's volume.

**The trade-off:** All of User A's 10,000 messages go to the same partition (Partition 0), so
they're processed sequentially by one consumer. User A's throughput is bounded by the consumer
processing rate, not multiplied across partitions. This is acceptable — it's fair degradation
(User A's flood only hurts User A, not others).

---

*Continue to: [DD3 — Worker Consumer & Sequential Executor, Line by Line](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD3_WORKER_ENGINE_LINE_BY_LINE.md)*
