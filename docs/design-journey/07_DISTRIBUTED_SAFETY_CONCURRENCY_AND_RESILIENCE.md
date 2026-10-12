# Chapter 7 — Distributed Safety, Concurrency & Resilience

> **ZapFlow Builder's Manual & Architecture Journey**  
> *Chapter 7 of 10*

---

## 7.1 Distributed Step Claiming & Lease Contracts

In a distributed cluster with multiple concurrent worker instances, two workers must never execute the exact same step simultaneously. Furthermore, if a worker process crashes mid-step (e.g., node evictions, out-of-memory errors), the system must detect the abandonment without creating duplicate side-effects.

In `apps/worker/src/services/claim.service.ts`:

```typescript
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

export async function claim(
  zapRunId: bigint,
  zapStepId: bigint,
): Promise<ClaimedStep | null> {
  // Atomic atomic claim using raw SQL
  const rows = await prisma.$queryRaw<ClaimedStep[]>`
    INSERT INTO zap_run_steps (zap_run_id, zap_step_id, status, claimed_at, worker_id)
    VALUES (${zapRunId}, ${zapStepId}, 'processing', now(), ${WORKER_ID})
    ON CONFLICT (zap_run_id, zap_step_id) DO NOTHING
    RETURNING id, zap_run_id AS "zapRunId", zap_step_id AS "zapStepId",
              idempotency_key::text AS "idempotencyKey", worker_id AS "workerId"
  `;

  if (rows.length > 0) {
    // Fresh claim: This worker owns execution rights
    return rows[0];
  }

  // Conflict: Another worker or execution pass touched this step
  const existing = await prisma.zapRunStep.findUnique({
    where: { zapRunId_zapStepId: { zapRunId, zapStepId } },
  });

  if (!existing || existing.status === 'completed') {
    return null; // Already finalized; safe no-op
  }

  // Check for expired worker lease
  if (
    existing.status === 'processing' &&
    existing.claimedAt &&
    Date.now() - existing.claimedAt.getTime() > env.WORKER_LEASE_TIMEOUT_MS
  ) {
    return reclaim(existing.id, zapRunId);
  }

  return null; // Actively held by a healthy live worker
}
```

### 7.1.1 The Ambiguous-Outcome Problem on Expired Leases

If Worker A claimed a step, initiated an HTTP call to charge a credit card on Stripe, and immediately experienced an OS SIGKILL, the step's `claimed_at` timestamp will eventually exceed `WORKER_LEASE_TIMEOUT_MS = 120000` (2 minutes).

When Worker B discovers this expired lease, **what should it do?**

```
┌────────────────────────────────────────────────────────────────────────┐
│                   THE AMBIGUOUS-OUTCOME DILEMMA                        │
├────────────────────────────────────────────────────────────────────────┤
│ Scenario A: Worker A's HTTP call failed before leaving the server.     │
│             Re-executing the step would be SAFE.                       │
│                                                                        │
│ Scenario B: Worker A's HTTP call reached Stripe and captured $500.     │
│             Re-executing the step would CHARGE THE CUSTOMER TWICE!     │
└────────────────────────────────────────────────────────────────────────┘
```

Because Worker B cannot differentiate between Scenario A and Scenario B, **ZapFlow adopts a zero-tolerance policy against duplicate financial/external mutations**:

```typescript
async function reclaim(rowId: bigint, zapRunId: bigint): Promise<null> {
  await prisma.zapRunStep.update({
    where: { id: rowId },
    data: {
      status: 'ambiguous',
      errorCode: 'LEASE_EXPIRED',
      errorMessage:
        'Worker holding this step went silent past lease timeout. Outcome of the underlying call is unknown — do not assume it failed.',
    },
  });

  // Explicitly mark the run failed so it never stays in_progress forever
  await markFailed(zapRunId, 'LEASE_EXPIRED', rowId);
  logger.warn({ zapRunStepId: rowId.toString() }, '[worker] Step marked ambiguous (lease expired)');
  return null;
}
```

Instead of blindly retrying a non-idempotent action:
1. The step is transitioned to status `'ambiguous'`.
2. The entire run is transitioned to `'failed'` with error code `'LEASE_EXPIRED'`.
3. An alert is logged for operator investigation.

---

## 7.2 Atomic Rate Limiting via Redis Lua Scripts

Third-party APIs enforce strict rate limits per connected account (e.g., Slack's 1 request per second per channel, or GitHub's token caps). If 100 webhooks arrive simultaneously for the same user, dispatching 100 concurrent requests results in `HTTP 429 Too Many Requests`.

In `apps/worker/src/services/rate-limiter.service.ts`:

```typescript
const ATOMIC_INCR_EXPIRE = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

export async function checkAndConsume(
  connectionId: bigint,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = `ratelimit:${connectionId}`;
  const client = getRedis();
  const count = await client.eval(ATOMIC_INCR_EXPIRE, 1, key, String(windowSeconds)) as number;
  return count <= limit;
}
```

### Why Standard Redis Multi-Commands Fail:
Without an atomic Lua script, naive rate limiters execute two roundtrips:
```typescript
// ❌ THE DANGEROUS MULTI-COMMAND PATTERN
const count = await redis.incr(key);
if (count === 1) {
  await redis.expire(key, 60); // What if the process crashes here?
}
```
If the container is killed between `INCR` and `EXPIRE`, the key is created **without a TTL expiration**. The key lives in Redis permanently, locking out that user's connection forever!

**The Lua Solution:**  
Redis executes Lua scripts **atomically in a single CPU cycle**. Either both the increment and TTL expiration succeed together, or neither does.

### Rate Limiting as Backpressure (Not Failure):
When `checkAndConsume` returns `false`:
```typescript
if (!underLimit) {
  await releaseWithDelay(claimedRowId);
  return { status: 'processing' };
}
```
The step is **not failed**. It is left in status `'processing'`, and `claimedAt` is bumped. The execution loop exits gracefully, allowing background retry jobs to pick up the task once the rate-limit window clears.

---

## 7.3 The Self-Healing Background Jobs Suite

In a production environment, edge-case failures are inevitable: relay processes crash, networks partition, and OAuth tokens silently expire. ZapFlow includes five dedicated background maintenance jobs to maintain cluster health.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      BACKGROUND JOBS FLEET                             │
├────────────────────────────────────────────────────────────────────────┤
│ 1. retryStuckSteps          (Every 2 min)  - Worker cron: Rate-limits  │
│ 2. recoverDispatchedOutbox  (Every 10 min) - API cron: Relay crashes   │
│ 3. stuckOutboxAlert         (Every 5 min)  - API cron: Sentry alerts   │
│ 4. refreshExpiringTokens    (Every 15 min) - API cron: OAuth renewal   │
│ 5. outboxCleanup            (Daily 00:00)  - API cron: Prune consumed  │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Job 1: `retryStuckSteps` (`apps/worker/src/services/retry-stuck-steps.job.ts`)
- **Frequency:** Every 2 minutes (`*/2 * * * *`).
- **Problem Solved:** When a step hits a rate limit, it returns `status = 'processing'`. Without an automated sweeper, the run remains paused indefinitely.
- **Action:** Queries all `zap_run_steps` in `'processing'` whose `claimedAt` is older than 2 minutes. Resets them with error code `'RATE_LIMIT_RETRY'` and confirms the parent `zap_runs` record remains in `'in_progress'` so that subsequent executor passes pick them up.

---

### Job 2: `recoverDispatchedOutbox` (`apps/app-api/src/jobs/recover-dispatched-outbox.job.ts`)
- **Frequency:** Every 10 minutes (`*/10 * * * *`).
- **Problem Solved:** If the `relay` process claims rows, sets `status = 'dispatched'`, and crashes before producing them to Kafka, those rows become permanently orphaned because the relay poller only queries `status = 'pending'`.
- **Action:** Queries outbox rows stuck in `'dispatched'` for longer than 15 minutes:
  ```typescript
  const result = await prisma.outbox.updateMany({
    where: {
      status: 'dispatched',
      createdAt: { lt: threshold },
    },
    data: { status: 'pending' },
  });
  ```
  Resets their status back to `'pending'`, allowing healthy relay instances to re-enqueue them automatically.

---

### Job 3: `stuckOutboxAlert` (`apps/app-api/src/jobs/stuck-outbox-alert.job.ts`)
- **Frequency:** Every 5 minutes (`*/5 * * * *`).
- **Problem Solved:** If an outbox row remains `'dispatched'` for longer than 30 minutes, it represents a critical failure: the worker received the Kafka event but crashed repeatedly before marking the outbox as `'consumed'`.
- **Action:** Gathers the affected row IDs and triggers a high-severity alert to **Sentry** with complete event diagnostic context, alerting on-call engineers.

---

### Job 4: `refreshExpiringTokens` (`apps/app-api/src/jobs/refresh-expiring-tokens.job.ts`)
- **Frequency:** Every 15 minutes (`*/15 * * * *`).
- **Problem Solved:** Although the worker implements lazy OAuth refresh on HTTP 401, idle connections whose tokens expire without execution can accumulate stale state.
- **Action:** Sweeps the `connections` table for tokens expiring within the next 30 minutes:
  $$\text{expires\_at} \le (\text{now}() + 30 \text{ minutes})$$
  Contacts the provider's OAuth token endpoint, receives refreshed credentials, encrypts them via AES-256-GCM, and updates the database.

---

### Job 5: `outboxCleanup` (`apps/app-api/src/jobs/outbox-cleanup.job.ts`)
- **Frequency:** Daily at midnight (`0 0 * * *`).
- **Problem Solved:** Over months of operation, high-volume webhooks can generate tens of millions of outbox rows, degrading PostgreSQL index performance and consuming disk storage.
- **Action:** Deletes rows where `status = 'consumed'` older than 7 days:
  ```typescript
  await prisma.outbox.deleteMany({
    where: {
      status: 'consumed',
      createdAt: { lt: cutoff },
    },
  });
  ```
  **Critical Constraint:** It explicitly ignores rows with status `'pending'`, `'dispatched'`, or `'dead'`, ensuring unhandled alerts or audit signals are never pruned.

In Chapter 8, we explore the management REST API, JWT authentication, and Next.js frontend integration.
