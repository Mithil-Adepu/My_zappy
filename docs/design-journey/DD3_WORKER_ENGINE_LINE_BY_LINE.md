# Deep Dive 3 — Worker Consumer & Sequential Executor: Every Line Explained

> The worker is where zaps actually execute. A Kafka consumer reads events, a sequential
> executor walks step-by-step through a zap's pipeline, and the step runner makes real HTTP
> calls to external APIs. This document explains every design decision — the recursion→iteration
> bug fix, the lease timeout ambiguity dilemma, template substitution type preservation,
> AJV relaxed validation, OAuth lazy refresh, and the five-outcome state machine.

---

## Table of Contents

1. [The Worker in Context](#1-the-worker-in-context)
2. [`worker/src/main.ts` — Process Bootstrap](#2-workersrcmaints--process-bootstrap)
3. [`consumer/run-consumer.ts` — Kafka Consumer](#3-consumerrun-consumerts--kafka-consumer)
4. [`engine/sequential-executor.ts` — The Step Walk Loop](#4-enginesequential-executorts--the-step-walk-loop)
5. [`services/claim.service.ts` — Distributed Step Locking](#5-servicesclaimservicets--distributed-step-locking)
6. [`services/run-state.service.ts` — Terminal State Management](#6-servicesrun-stateservicets--terminal-state-management)
7. [`engine/step-runner.ts` — The 8-Stage Action Pipeline](#7-enginestep-runnerts--the-8-stage-action-pipeline)
8. [`engine/template-substitution.ts` — Type-Preserving Template Engine](#8-enginetemplate-substitutiontss--type-preserving-template-engine)
9. [`engine/payload-validator.ts` — Relaxed AJV Validation](#9-enginepayload-validatorts--relaxed-ajv-validation)
10. [`engine/filter-evaluator.ts` — Filter Step Logic](#10-enginefilter-evaluatorts--filter-step-logic)
11. [`lib/resolve-path.ts` — Dot-Notation Path Resolver](#11-libresolve-pathts--dot-notation-path-resolver)
12. [`services/rate-limiter.service.ts` — Redis Token Bucket](#12-servicesrate-limiterservicets--redis-token-bucket)
13. [`services/token-refresh.service.ts` — OAuth Credential Management](#13-servicestoken-refreshservicets--oauth-credential-management)
14. [`services/encrypt.helper.ts` — AES-256-GCM At-Rest Encryption](#14-servicesencrypthelparts--aes-256-gcm-at-rest-encryption)

---

## 1. The Worker in Context

The worker's place in the pipeline:

```
Kafka topic: zap.run.requested
      ↓
run-consumer.ts (eachBatch loop)
      ↓
onMessage() → upserts zap_run to 'in_progress'
      ↓
sequential-executor.resume() → walks step positions
  ├── trigger step → mark completed, alias payload
  ├── filter step → evaluate conditions
  │   ├── pass → continue
  │   └── fail → markFiltered() [terminal]
  └── action step → step-runner.runStep()
      ├── rate limit check
      ├── template substitution
      ├── AJV validation
      ├── get credentials (decrypt)
      ├── build request + HTTP call
      ├── 401 + OAuth → refresh + retry
      └── result → 'completed' | 'failed' | 'ambiguous' | 'processing'
```

---

## 2. `worker/src/main.ts` — Process Bootstrap

**File:** `apps/worker/src/main.ts`

### Lines 1–17: Imports and connector registration

```typescript
import './connectors/registry';
```

This import has **side effects**. `registry.ts`'s top-level code calls `registerAdapter()` three
times (Slack, Razorpay, GitHub). Importing it here triggers those registrations before the
consumer starts processing messages. Without this import, `getAdapter('slack:send-message')` would
throw "No adapter registered" when the worker tries to execute a Slack action.

This pattern (side-effect import) is used because TypeScript's tree-shaking can eliminate unused
imports. By explicitly importing `registry.ts` even though we don't use any of its exports, we
guarantee the side-effect registration code runs.

### Lines 19–41: Health endpoint

```typescript
const app = express();

app.get('/health', async (_req, res) => {
  try {
    if (!isConsumerHealthy) {
      res.status(503).json({ status: 'error', kafka: false });
      return;
    }
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true, kafka: true });
  } catch (err) {
    res.status(503).json({ status: 'error', db: false });
  }
});
```

**Two-dimensional health check:** The worker has two critical dependencies — Postgres and Kafka.
The `isConsumerHealthy` boolean is exported from `run-consumer.ts` and is set to `false` when the
Kafka consumer crashes or stops unexpectedly. Both DB and Kafka health are reported separately.

**Why not just ping Kafka?** Pinging the Kafka broker requires making a metadata request, which
takes 50-200ms and creates unnecessary broker load for health checks every 10 seconds. Instead, we
track the consumer's crash/stop events, which are emitted by KafkaJS's event system.

### Lines 43–63: Graceful shutdown

```typescript
process.on('SIGTERM', async () => {
  logger.info('[worker] SIGTERM received — finishing in-flight step before exit');
  await pauseConsumer();

  // Give in-flight step a moment to finish
  await new Promise((resolve) => setTimeout(resolve, 5000));

  await disconnectConsumer();
  await disconnectRedis();
  await prisma.$disconnect();
  process.exit(0);
});
```

**The 5-second pause:** `pauseConsumer()` stops fetching new Kafka messages but does NOT
interrupt an in-flight `onMessage()` call. The 5000ms sleep gives the currently executing step
(which may be making an HTTP call to Slack or GitHub) time to complete. Without this pause, we'd
disconnect the consumer, then disconnect Redis and Postgres mid-execution. The in-flight step's
DB update (marking the step status) would fail with "connection closed."

**`pauseConsumer()` vs `disconnectConsumer()`:** `pause` signals KafkaJS to stop fetching more
messages from the broker but keeps the consumer registered in the group. `disconnect` removes the
consumer from the group, which triggers a partition rebalance (other consumers pick up the
partitions). We pause first to drain gracefully, then disconnect.

### Lines 74–80: Retry stuck steps cron

```typescript
cron.schedule('*/2 * * * *', async () => {
  try {
    await retryStuckSteps();
  } catch (err) {
    logger.error({ err }, '[worker] retryStuckSteps cron failed');
  }
});
```

The `*/2 * * * *` cron expression means "every 2 minutes." `retryStuckSteps` finds steps stuck
in `processing` state for > 2 minutes (RETRY_AFTER_MINUTES = 2) and resets them. The cron
interval matches the constant — if `RETRY_AFTER_MINUTES` is increased, this should be updated too.

---

## 3. `consumer/run-consumer.ts` — Kafka Consumer

**File:** `apps/worker/src/consumer/run-consumer.ts`

### Lines 9–11: Module-level state

```typescript
let consumer: Consumer | null = null;
export let isConsumerHealthy = true;
let shuttingDown = false;
```

- `consumer` — singleton. One Kafka consumer instance per process. Kafka consumers maintain TCP
  connections to the broker and heartbeat sessions; creating multiple is wasteful.
- `isConsumerHealthy` — exported so `main.ts`'s health endpoint can read it.
- `shuttingDown` — prevents processing new messages after `SIGTERM` is received.

### Lines 13–51: `getConsumer()` — Lazy singleton factory

```typescript
export function getConsumer(): Consumer {
  if (!consumer) {
    const kafka = new Kafka({
      clientId: env.KAFKA_CLIENT_ID,
      brokers: env.KAFKA_BROKERS.split(','),
      ...(env.KAFKA_USERNAME && env.KAFKA_PASSWORD && {
        ssl: true,
        sasl: {
          mechanism: 'scram-sha-256',
          username: env.KAFKA_USERNAME,
          password: env.KAFKA_PASSWORD,
        },
      }),
      retry: { initialRetryTime: 300, retries: 10 },
    });
    consumer = kafka.consumer({ groupId: env.KAFKA_GROUP_ID_WORKER });
```

**SASL/SCRAM authentication:** The spread operator `...(condition && { ... })` conditionally
includes SASL config only if `KAFKA_USERNAME` and `KAFKA_PASSWORD` are set. In local dev with a
plain Kafka broker (no auth), these env vars are absent, so no SASL config is included. In
production with Upstash Kafka, SASL_SCRAM + SSL is required.

**Why SCRAM-SHA-256?** Upstash Kafka uses SASL/SCRAM-SHA-256 as its authentication mechanism.
SCRAM (Salted Challenge Response Authentication Mechanism) is more secure than PLAIN because it
uses challenge-response — the password is never sent in cleartext even over TLS.

**`retry: { initialRetryTime: 300, retries: 10 }`** — KafkaJS retry config. The broker might be
slow to respond on first startup in KRaft mode (Kafka without ZooKeeper). `initialRetryTime: 300`
means first retry after 300ms, then exponential backoff. `retries: 10` means up to 10 retry
attempts before giving up. With exponential backoff capped at 30 seconds, this covers up to ~90
seconds of broker unavailability.

```typescript
    // Exit process on fatal crash so Docker can restart the container
    consumer.on(consumer.events.CRASH, (e) => {
      isConsumerHealthy = false;
      logger.error({ err: e.payload.error }, '[worker] Kafka consumer crashed! Exiting to allow Docker to restart.');
      process.exit(1);
    });

    // KafkaJS can sometimes stop without crashing
    consumer.on(consumer.events.STOP, () => {
      if (!shuttingDown) {
        isConsumerHealthy = false;
        logger.error('[worker] Kafka consumer stopped unexpectedly! Exiting to allow Docker to restart.');
        process.exit(1);
      }
    });
```

**Why `process.exit(1)` on crash?** Docker's restart policy (`restart: always` or
`restart: unless-stopped`) restarts a container when it exits with a non-zero code. By exiting
with 1 on crash, we let Docker's battle-tested restart mechanism handle recovery. The alternative
— trying to recover the consumer in-process — is complex and error-prone. Let the container die
and be reborn.

**`if (!shuttingDown)`** — the STOP event fires both on unexpected stops AND on graceful shutdown.
We only want to `process.exit(1)` for unexpected stops. The `shuttingDown` flag distinguishes
intentional shutdown (where we call `disconnectConsumer()` which triggers STOP) from unexpected
stops.

### Lines 61–185: `onMessage()` — The Core Message Handler

```typescript
export async function onMessage(event: ZapRunRequestedEvent): Promise<void> {
  if (shuttingDown) return;

  const webhookEventId = BigInt(event.webhookEventId);
  const zapId = BigInt(event.zapId);
```

**`BigInt(event.webhookEventId)`** — The Kafka message stores IDs as strings (JSON can't
serialize bigint). We convert back to `bigint` for DB operations.

**The idempotency challenge:** Kafka guarantees at-least-once delivery. The same message can be
delivered twice (broker crash + leader election, network issues, consumer rebalance). `onMessage`
must be idempotent — processing the same message twice must not cause double-execution.

```typescript
  // 1. Try to claim a queued run (new webhooks)
  let rows = await prisma.$queryRaw<Array<{ id: bigint; step_snapshot: unknown }>>`
    UPDATE zap_runs
    SET
      status = 'in_progress',
      step_snapshot = (SELECT json_agg(
        json_build_object(
          'id', zs.id,
          'position', zs.position,
          'stepType', zs.step_type,
          ...
        ) ORDER BY zs.position
      ) FROM zap_steps zs WHERE zs.zap_id = ${zapId})
    WHERE webhook_event_id = ${webhookEventId} AND status = 'queued'
    RETURNING id, step_snapshot
  `;
```

**This is an atomic UPDATE-with-SELECT:** It atomically:
1. Transitions `zap_runs.status` from `'queued'` to `'in_progress'`
2. Captures a snapshot of the current `zap_steps` configuration (using `json_agg`)
3. Returns the affected row

**The `step_snapshot` — why it exists:** When the worker starts executing a zap run, it reads the
zap's steps. But zap steps can change! The user can add or remove steps from a zap at any time
through the management API. If the worker reads `zap_steps` 5 seconds into execution, the steps
might have changed since the run started.

**Solution:** At the moment we transition to `in_progress`, we take an immutable snapshot of the
current step configuration. This snapshot is stored as JSONB in `zap_runs.step_snapshot`. All
subsequent execution reads from this snapshot, not from the live `zap_steps` table. The run
executes against the steps as they were when it started.

**`WHERE status = 'queued'`** — the idempotency guard. If the same Kafka message is delivered
twice, the second delivery finds the `status = 'in_progress'` (or terminal) and the UPDATE
returns 0 rows. The second delivery falls through to the fallback path.

**`json_build_object` key names:** The keys in `json_build_object` must be camelCase
(`'stepType'`, `'availableActionId'`) to match the TypeScript `SnapshotStep` interface in
`sequential-executor.ts`. If you use snake_case keys here but camelCase in the TypeScript
interface, you'll get `undefined` for every field. This is a subtle but catastrophic mismatch.

```typescript
  // 2. Fallback for old webhooks that never got a 'queued' row
  if (rows.length === 0) {
    rows = await prisma.$queryRaw<...>`
      INSERT INTO zap_runs (zap_id, webhook_event_id, status, step_snapshot)
      SELECT ...
      ON CONFLICT (webhook_event_id) DO NOTHING
      RETURNING id, step_snapshot
    `;
  }
```

**Why two paths?** The `'queued'` state was introduced later in development. Old outbox rows
(dispatched before the `queued` state was added) would have no corresponding `zap_run` row at all.
The INSERT fallback handles these legacy cases. The `ON CONFLICT DO NOTHING` means: if a run
already exists for this webhook event (Kafka redeliver), do nothing and return 0 rows.

```typescript
  if (rows.length > 0) {
    zapRun = { id: rows[0].id, stepSnapshot: rows[0].step_snapshot };
  } else {
    // Run already exists (Kafka redeliver) — fetch it
    const existing = await prisma.zapRun.findUnique({
      where: { webhookEventId },
      select: { id: true, stepSnapshot: true, status: true },
    });

    if (!existing) {
      logger.error({ webhookEventId: event.webhookEventId }, '[worker] Cannot find run for webhookEventId');
      return;
    }

    if (['completed', 'failed', 'filtered'].includes(existing.status)) {
      logger.info({ ... }, '[worker] Run already terminal — skipping');
      return;
    }

    zapRun = { id: existing.id, stepSnapshot: existing.stepSnapshot };
  }
```

**The three-path idempotency handling:**

1. `rows.length > 0` — successfully claimed a new/queued run. Continue.
2. `rows.length === 0`, but run exists with terminal status — Kafka redeliver after completion.
   Return immediately. Do not re-execute.
3. `rows.length === 0`, run exists with `in_progress` status — Kafka redeliver while still
   running. The sequential-executor's resume logic handles this: it finds the
   `maxCompletedPosition` and starts from there.

```typescript
  // Mark outbox consumed
  await prisma.outbox.updateMany({
    where: { webhookEventId },
    data: { status: 'consumed', consumedAt: new Date() },
  });
```

**`updateMany`** — marks all outbox rows for this webhook event as consumed. Normally there's one
outbox row per webhook event, but `updateMany` handles edge cases defensively.

**Why mark consumed?** The outbox row lifecycle: `pending` → `dispatched` (relay) → `consumed`
(worker). Once the worker has the Kafka message and starts the run, the outbox row has done its
job. Marking it `consumed` with a timestamp allows:
1. The `outbox-cleanup.job.ts` cron to delete old consumed rows (after 7 days).
2. Operators to see execution latency: `consumedAt - createdAt` = total relay+consumer latency.

```typescript
  // §11 — Per-zap hourly run cap
  const underCap = await underRunCap(zapId, zap.maxRunsPerHour);
  if (!underCap) {
    await prisma.zapRun.update({
      where: { id: zapRun.id },
      data: { status: 'failed', completedAt: new Date() },
    });
    return;
  }
```

**Rate cap self-protection:** Each zap has a `maxRunsPerHour` field (default: 100). This protects
against runaway automation — if a zap's trigger webhook fires 1000 times per hour (e.g., due to
a bug in the user's code), it would only execute 100 times. The remaining 900 runs are marked
`failed` with the rate-limit error. This prevents a single zap from monopolizing the worker.

### Lines 216–250: `startConsumer()` and `eachBatch`

```typescript
await c.run({
  autoCommit: false,
  eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
    for (const message of batch.messages) {
      if (shuttingDown) break;
      ...
      try {
        const event = JSON.parse(message.value.toString()) as ZapRunRequestedEvent;
        await onMessage(event);
      } catch (err) {
        logger.error({ err }, '[worker] Error processing message');
      }

      resolveOffset(message.offset);
      await heartbeat();
    }
    await commitOffsetsIfNecessary();
  },
});
```

**`eachBatch` vs `eachMessage`:** This is the most important KafkaJS choice in the entire codebase.

With `eachMessage`: KafkaJS calls your handler for each message and blocks until it resolves.
During processing, KafkaJS **cannot heartbeat**. If processing takes > `sessionTimeout` (default:
30 seconds in KafkaJS), the broker thinks the consumer is dead, removes it from the group, and
reassigns its partitions to other consumers. The in-flight message may be redelivered to another
consumer. This is a **session timeout rebalance bug**.

With `eachBatch`: You get the raw batch and all control primitives. You manually call `heartbeat()`
after each message. KafkaJS can heartbeat during processing, preventing session timeouts even for
long-running steps.

**`autoCommit: false`** — we manually manage offset commits. With `autoCommit: true`, KafkaJS
commits offsets periodically (every 5 seconds). If the consumer crashes after auto-commit but
before processing, the message is lost. With manual commit, we control exactly when offsets are
committed.

**`resolveOffset(message.offset)`** — tells KafkaJS "I've processed this message, include its
offset in the next commit." Note: `resolveOffset` doesn't commit — it marks the offset as ready
to commit.

**`commitOffsetsIfNecessary()`** — commits all resolved offsets to Kafka at the end of each
batch. Called once per batch, not per message. If the consumer crashes mid-batch, only the
processed messages (whose offsets were resolved) are committed. Unprocessed messages are
redelivered.

**`try/catch` around `onMessage`** — if `onMessage` throws (unexpected DB error, etc.), we log
it, `resolveOffset` the message (mark it as "handled," even though it errored), and continue to
the next message. Without this, a single bad message would break the entire batch processing loop.
The trade-off: a message that consistently causes `onMessage` to throw will be silently skipped
(poison pill message). A dead-letter queue would be the proper solution for production-grade
poison pill handling.

---

## 4. `engine/sequential-executor.ts` — The Step Walk Loop

**File:** `apps/worker/src/engine/sequential-executor.ts`

### Lines 8–23: Interfaces

```typescript
interface ZapRunWithSnapshot {
  id: bigint;
  zapId: bigint;
  stepSnapshot: unknown;
  payloadContext?: Record<string, unknown>;
}

interface SnapshotStep {
  id: bigint | string;
  position: number;
  stepType: 'trigger' | 'action' | 'filter';
  availableActionId: string | null;
  connectionId: bigint | string | null;
  config: Record<string, unknown>;
  availableAction?: { inputSchema: Record<string, unknown> | null } | null;
}
```

**`id: bigint | string`** — The step snapshot is built by `json_build_object` in SQL. PostgreSQL
serializes `bigint` columns as strings when building JSON. So even though the DB column is
`bigint`, the JSON representation is a string like `"42"`. The `| string` in the union type
handles this. When we call `BigInt(nextStep.id)`, it converts either a native bigint or a string
to bigint.

**`availableAction?: { inputSchema: ... } | null`** — Optional because the SQL's correlated
subquery `SELECT json_build_object('inputSchema', aa.input_schema) FROM available_actions aa
WHERE aa.id = zs.available_action_id` returns null if the step doesn't have an
`available_action_id` (i.e., filter steps and trigger steps). The `?` means the field may be
absent entirely from the JSON.

### Lines 36–53: Resume entry point and position calculation

```typescript
export async function resume(
  zapRun: ZapRunWithSnapshot,
  payloadContext: Record<string, unknown>,
): Promise<void> {
  const steps = (zapRun.stepSnapshot as SnapshotStep[]) ?? [];

  const completedSteps = await prisma.zapRunStep.findMany({
    where: { zapRunId: zapRun.id, status: 'completed' },
    include: { zapStep: { select: { position: true } } },
  });

  const maxCompletedPosition =
    completedSteps.length > 0
      ? Math.max(...completedSteps.map((s) => s.zapStep.position))
      : -1;

  let currentPosition = maxCompletedPosition + 1;
  let currentContext = payloadContext;
```

**Why find `maxCompletedPosition`?** The executor can be called multiple times for the same run.
This happens when:
- A rate-limited step returns `processing`, the executor exits, the retry cron fires, and the
  run is re-triggered.
- A Kafka message is redelivered after a partial execution.
- The worker crashes mid-run and Docker restarts it.

By finding the highest completed position, we know exactly where to resume from. We don't re-
execute steps that already completed. This is the foundation of crash recovery.

**`maxCompletedPosition = -1` when no steps completed** — so `currentPosition = -1 + 1 = 0`,
which is the trigger step. A fresh run starts at position 0.

**`Math.max(...completedSteps.map(...position))`** — the spread operator passes all positions
as individual arguments to `Math.max`. Equivalent to `Math.max(0, 1, 2, ...)`. If there are
thousands of completed steps, the spread could overflow the argument stack. In practice, a zap
has a maximum of ~50 steps (UI limitation), so this is safe.

### Lines 56–157: The iterative loop — Bug B14 Fix

```typescript
// Iterative loop — replaces recursive resume() calls
while (true) {
  const nextStep = steps.find((s) => s.position === currentPosition);

  if (!nextStep) {
    // All steps done — mark completed
    await markCompleted(zapRun.id);
    return;
  }
```

**Why iteration instead of recursion?**

The original implementation used recursion:
```typescript
// ORIGINAL (BUGGY) — DO NOT USE
async function resume(zapRun, payloadContext, position = 0) {
  const nextStep = steps.find(s => s.position === position);
  if (!nextStep) { await markCompleted(zapRun.id); return; }
  // ... process step ...
  await resume(zapRun, newContext, position + 1); // RECURSIVE CALL
}
```

For a zap with N steps, this creates N stack frames. Node.js has a default stack limit of ~10,000
frames. For N = 100 steps (theoretically possible with many filter steps), this is fine. But with
N = 200 steps, you'd get a stack overflow error mid-execution. The run would be aborted without
marking itself as failed — stuck at `in_progress` forever.

**The B14 fix:** Convert to iteration with `while (true)`:
```typescript
while (true) {
  const nextStep = ...;  // find current position
  if (!nextStep) { markCompleted(); return; }  // all done
  
  // process step...
  
  if (result.status === 'completed') {
    currentContext = { ...currentContext, ... };
    currentPosition++;   // advance
    continue;            // loop back to top
  }
  
  return;  // terminal (failed, ambiguous, processing)
}
```

**Identical semantics, O(1) stack.** The `while (true)` loop with `continue` is exactly
equivalent to the recursive call. No stack frames accumulate. A zap with 10,000 steps (if
someone builds one) would still work correctly.

### Lines 75–89: Trigger step handling

```typescript
if (nextStep.stepType === 'trigger') {
  await markStepCompleted(claimed.id, { result: 'Trigger successfully fired' });
  
  // Alias the webhook payload into step_1 so users can map {{step_1.payload...}}
  currentContext = {
    ...currentContext,
    [`step_${currentPosition + 1}`]: payloadContext,
  };

  currentPosition++;
  continue;
}
```

**Why "complete" the trigger step?** The trigger step doesn't actually do anything at execution
time — it already fired (the webhook already arrived). But we still create a `zap_run_step` row
for it with status `completed`, so the frontend can show "Trigger ✓" in the execution timeline.

**Template aliasing — `step_1`, `step_2`, ...:** After the trigger step (position 0), the webhook
payload is aliased into `currentContext['step_1']`. After action step at position 1 completes, its
output is aliased into `currentContext['step_2']`. This is the convention that allows users to
write `{{step_1.payload.amount}}` in their action configs to reference the trigger payload's
`amount` field.

**Why `currentPosition + 1` for the key?** Positions are 0-indexed in the DB, but the UI shows
steps as 1-indexed. A step at position 0 is "step 1" in the UI. So `step_${currentPosition + 1}`
converts the 0-indexed position to the 1-indexed UI label.

### Lines 92–106: Filter step handling

```typescript
if (nextStep.stepType === 'filter') {
  const passed = evaluateFilter(nextStep.config, currentContext);

  await markStepCompleted(claimed.id, { passed });

  if (!passed) {
    await markFiltered(zapRun.id);
    return; // Terminal: filtered
  }

  currentPosition++;
  continue;
}
```

**`markStepCompleted(claimed.id, { passed })`** — we mark the filter step completed with the
evaluation result `{ passed: true/false }`. Even when the filter fails (run is filtered), we mark
the filter step itself as `completed` with `{ passed: false }`. This distinction is important:
the step didn't error, it was evaluated and the filter condition was not met.

**`markFiltered(zapRun.id)`** — marks the entire run as `filtered` status. `filtered` is a
terminal state — not failure, not success. It means "the automation ran correctly, but a filter
step determined that this particular event should not trigger the action."

### Lines 108–156: Action step handling

```typescript
const stepForRunner = {
  id: stepId,
  availableActionId: nextStep.availableActionId,
  connectionId: nextStep.connectionId ? BigInt(nextStep.connectionId) : null,
  config: nextStep.config,
  availableAction: nextStep.availableAction,
};

const result = await runStep(
  stepForRunner,
  currentContext,
  claimed.idempotencyKey,
  claimed.id,
);

await recordStepResult(claimed.id, result);
```

**`BigInt(nextStep.connectionId)`** — same reason as with step IDs: the step snapshot stores
bigint values as strings in JSON. `BigInt()` converts the string back.

**`claimed.idempotencyKey`** — a UUID generated at claim time. Passed to the step runner to be
used as `X-Idempotency-Key` for connectors that support it (Razorpay). This ensures that if the
step is retried (e.g., after a network timeout), the external provider can recognize the duplicate
request and idempotently return the same result without executing the action twice.

```typescript
if (result.status === 'completed') {
  currentContext = {
    ...currentContext,
    [`step_${currentPosition + 1}`]: result.output ?? {},
  };
  currentPosition++;
  continue;
}

if (result.status === 'processing') {
  return; // Rate-limited — leave in processing, retry via cron
}

if (result.status === 'ambiguous') {
  logger.error({ ... }, '[ALERT] Step transitioned to ambiguous — run halted. Manual investigation required.');
} else {
  logger.warn({ ... }, 'step failed — run halted');
}
await markFailed(zapRun.id, result.errorCode ?? result.status, stepId);
return;
```

**The four step outcomes:**

| `result.status` | What happened | Response |
|---|---|---|
| `completed` | Action succeeded, output available | Merge output into context, advance |
| `processing` | Rate-limited, not executed yet | Exit, cron will retry |
| `failed` | Action failed with known error | Mark run failed, halt |
| `ambiguous` | Network timeout — outcome unknown | Mark run failed, log ALERT, halt |

**Why `ambiguous` gets a separate log level?** When a step is `ambiguous`, the external API may
have received the request. If the action was "charge customer $100", the customer may or may not
have been charged. Retrying blindly could double-charge. The `logger.error` with `[ALERT]` ensures
this surfaces prominently in the logs and Sentry for manual investigation. A failed step (known
error like 400 Bad Request) can be safely retried. An ambiguous step cannot.

---

## 5. `services/claim.service.ts` — Distributed Step Locking

**File:** `apps/worker/src/services/claim.service.ts`

### Lines 7: Worker ID

```typescript
const WORKER_ID = `worker-${process.pid}-${Date.now()}`;
```

A unique identifier for this worker process instance. `process.pid` is the OS process ID.
`Date.now()` adds a timestamp to disambiguate if the same PID is reused (after restart).
Combined: `worker-12345-1728738400000`. This is stored in `zap_run_steps.worker_id` to track
which worker instance claimed each step.

### Lines 26–67: `claim()` — The Three-Outcome Lock

```typescript
export async function claim(
  zapRunId: bigint,
  zapStepId: bigint,
): Promise<ClaimedStep | null> {
  const rows = await prisma.$queryRaw<ClaimedStep[]>`
    INSERT INTO zap_run_steps (zap_run_id, zap_step_id, status, claimed_at, worker_id)
    VALUES (${zapRunId}, ${zapStepId}, 'processing', now(), ${WORKER_ID})
    ON CONFLICT (zap_run_id, zap_step_id) DO NOTHING
    RETURNING id, zap_run_id AS "zapRunId", zap_step_id AS "zapStepId",
              idempotency_key::text AS "idempotencyKey", worker_id AS "workerId"
  `;
```

**`ON CONFLICT (zap_run_id, zap_step_id) DO NOTHING RETURNING id`** — this is the core of the
distributed step lock. The `zap_run_steps` table has a `UNIQUE(zap_run_id, zap_step_id)`
constraint. Only one worker can successfully INSERT for a given `(run, step)` pair. All others
get 0 rows returned.

**Why `$queryRaw` instead of `prisma.zapRunStep.create`?** Prisma's `.create()` method doesn't
support `ON CONFLICT DO NOTHING RETURNING` in a single operation. It uses standard INSERT and
would throw if there's a conflict (unique constraint violation). We need the native PostgreSQL
`ON CONFLICT DO NOTHING RETURNING` clause to distinguish "inserted successfully" from "conflict
was hit" — and Prisma's upsert doesn't support this exact pattern either.

**`idempotency_key::text AS "idempotencyKey"`** — the `idempotency_key` column is a PostgreSQL
UUID type. The `::text` cast converts it to a string for JSON serialization. Without it, KafkaJS's
JSON would serialize the UUID as an object `{uuid: "..."}` instead of a plain string.

```typescript
  if (rows.length > 0) {
    return rows[0]; // Fresh claim — we own it
  }

  // Conflict — check existing row
  const existing = await prisma.zapRunStep.findUnique({
    where: { zapRunId_zapStepId: { zapRunId, zapStepId } },
  });

  if (!existing) return null;

  if (existing.status === 'completed') {
    return null; // Already done — safe no-op
  }

  if (
    existing.status === 'processing' &&
    existing.claimedAt &&
    Date.now() - existing.claimedAt.getTime() > env.WORKER_LEASE_TIMEOUT_MS
  ) {
    return reclaim(existing.id, zapRunId); // Lease expired
  }

  return null; // Actively owned by a live worker — back off
```

**The three conflict outcomes:**

1. **`status === 'completed'`** — the step was already executed. Safe to return null. The
   sequential executor won't re-execute because the step's position is already past
   `maxCompletedPosition`.

2. **Lease expired** (`status === 'processing'` AND `claimedAt` is old) — the previous worker
   claimed this step, started executing, then went silent. The lease timeout
   (`WORKER_LEASE_TIMEOUT_MS = 120000` = 2 minutes) has expired. See `reclaim()` below.

3. **Active worker** (`status === 'processing'` AND `claimedAt` is recent) — another worker is
   actively executing this step. We back off and return null. The sequential executor returns
   early without marking the run failed.

### Lines 69–91: `reclaim()` — The Ambiguous Outcome Handler

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
  await markFailed(zapRunId, 'LEASE_EXPIRED', rowId);
  logger.warn({ ... }, '[worker] Step marked ambiguous (lease expired) — requires manual review');
  return null;
}
```

**The ambiguous outcome dilemma:** A step's lease expired. The previous worker was executing this
step. We don't know if:

- Option A: The worker died before making the HTTP call to the external API. **Safe to retry.**
- Option B: The worker made the HTTP call, the external API received it and executed, but the
  worker died before recording the result. **Retrying would double-execute.**

We cannot distinguish A from B without the external API's help (idempotency key). For connectors
that support `X-Idempotency-Key` (Razorpay), Option B becomes safe to retry — the API returns
the same result for the same key. For Slack (no idempotency support), Option B could send
duplicate messages.

**The conservative choice:** `reclaim()` NEVER retries. It marks the step `ambiguous` and the
run `failed`. This prevents double-charges and duplicate messages at the cost of requiring manual
investigation for every expired lease. This is the correct choice for an automation platform
where data integrity outweighs convenience.

### Lines 118–125: `releaseWithDelay` — Rate-Limit Reset

```typescript
export async function releaseWithDelay(claimedId: bigint): Promise<void> {
  // Reset claimedAt to keep the lease fresh.
  await prisma.zapRunStep.update({
    where: { id: claimedId },
    data: { claimedAt: new Date() },
  });
}
```

When a step is rate-limited (step-runner returns `processing`), we want to retry it later. But
the step is currently in `processing` status with an old `claimedAt`. If we leave it, the lease
timeout will fire within 2 minutes and mark it `ambiguous`. We don't want that — rate limiting
is not an error.

`releaseWithDelay` refreshes `claimedAt` to now. This "resets the lease timer" — the step
remains `processing` but with a fresh timestamp. The `retryStuckSteps` cron fires every 2
minutes and marks processing steps older than `RETRY_AFTER_MINUTES` as `failed` (with
`RATE_LIMIT_RETRY` error code), allowing the executor to re-execute them.

---

## 6. `services/run-state.service.ts` — Terminal State Management

**File:** `apps/worker/src/services/run-state.service.ts`

```typescript
export async function markCompleted(zapRunId: bigint): Promise<void> {
  await prisma.zapRun.update({
    where: { id: zapRunId },
    data: { status: 'completed', completedAt: new Date() },
  });
}

export async function markFiltered(zapRunId: bigint): Promise<void> {
  await prisma.zapRun.update({
    where: { id: zapRunId },
    data: { status: 'filtered', completedAt: new Date() },
  });
}

export async function markFailed(zapRunId, reason, stepId?) { ... }
```

**Why a dedicated service?** The sequential executor has multiple terminal branches — after filter
failure, after action failure, after ambiguous outcome. Centralizing these three functions ensures:

1. Every terminal transition sets `completedAt`. No run is left without a completion timestamp.
2. The logger call is consistent across all failure paths.
3. If you need to add Sentry capture for run failures, you change one file.

**`completedAt: new Date()`** — every terminal state sets `completedAt` to the current time.
The frontend uses `completedAt - createdAt` to compute run duration. Without this, duration
would be `undefined` for failed/filtered runs.

---

## 7. `engine/step-runner.ts` — The 8-Stage Action Pipeline

**File:** `apps/worker/src/engine/step-runner.ts`

### Lines 10–16: `StepRunResult` type

```typescript
export interface StepRunResult {
  status: 'completed' | 'failed' | 'ambiguous' | 'processing';
  output?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  unresolvedFields?: string[];
}
```

**`unresolvedFields`** — even a successful step can have unresolved template fields (e.g., if a
field was optional and its template reference resolved to null). This list is surfaced in the
step's output so the user can see "field X was not mapped" in the execution log.

### Lines 47–53: Early exit for misconfigured steps

```typescript
if (!step.availableActionId || !step.connectionId) {
  return {
    status: 'failed',
    errorCode: 'STEP_MISCONFIGURED',
    errorMessage: 'Step is missing availableActionId or connectionId',
  };
}
```

A step without an action ID or connection ID cannot be executed. This catches configuration bugs
early with a clear error code, rather than letting a null dereference crash deeper in the
pipeline.

### Stage 1: Rate limit check (Lines 55–66)

```typescript
const underLimit = await checkAndConsume(
  step.connectionId,
  env.WORKER_RATE_LIMIT_PER_CONNECTION,
  env.WORKER_RATE_LIMIT_WINDOW_SECONDS,
);

if (!underLimit) {
  await releaseWithDelay(claimedRowId);
  return { status: 'processing' };
}
```

**`checkAndConsume`** — atomically checks and consumes one token from the Redis rate limiter for
this `connectionId`. If the connection has exceeded `WORKER_RATE_LIMIT_PER_CONNECTION` requests
in `WORKER_RATE_LIMIT_WINDOW_SECONDS`, it returns `false`.

**Why rate limit per connection (not per zap or per user)?** A `connection` represents a specific
app credential (e.g., "User A's Slack workspace"). A user could have multiple zaps all using the
same Slack connection. Rate limiting per connection prevents one user from exhausting Slack's API
rate limits across multiple zaps. If we rate-limited per zap, a user with 10 zaps pointing at
the same Slack connection would bypass the effective rate limit by a factor of 10.

**`releaseWithDelay(claimedRowId)`** — refreshes the claim's `claimedAt` timestamp before
returning `processing`. Without this, the claim would appear "old" and trigger the lease timeout
before the retry cron has a chance to reset it.

### Stage 2: Template substitution (Lines 68–72)

```typescript
const { mappedPayload, unresolvedFields } = substituteTemplates(
  step.config,
  payloadContext,
);
```

`step.config` is the raw step configuration as stored in the DB — e.g.:
```json
{
  "channel": "#alerts",
  "text": "Payment {{step_1.amount}} received from {{step_1.customer_name}}"
}
```

`payloadContext` contains the resolved values from previous steps:
```json
{
  "step_1": { "amount": 5000, "customer_name": "Alice" }
}
```

After substitution, `mappedPayload` becomes:
```json
{
  "channel": "#alerts",
  "text": "Payment 5000 received from Alice"
}
```

### Stage 3: AJV validation (Lines 74–88)

```typescript
const validation = validateMappedPayload(
  mappedPayload,
  step.availableAction?.inputSchema ?? null,
  unresolvedFields,
);

if (!validation.success) {
  return {
    status: 'failed',
    errorCode: validation.errorCode,
    errorMessage: validation.errorMessage,
    unresolvedFields,
  };
}
```

AJV validates the `mappedPayload` against the action's `inputSchema` (a JSON Schema). This catches
type mismatches (e.g., a field expected to be a number but resolved to a string) before making the
HTTP call. The `unresolvedFields` are passed to the validator to apply "relaxed" validation — see
DD3 Section 9.

### Stage 4: Get credentials (Line 91)

```typescript
const credentials = await getCredentials(step.connectionId);
```

Fetches the connection's encrypted credentials from Postgres and decrypts them using AES-256-GCM.
Returns a discriminated union: `{ type: 'oauth', accessToken, refreshToken }` or
`{ type: 'api_key', apiKey, apiSecret }`.

### Stages 5–8: `executeWithRefresh` (Lines 121–180)

```typescript
async function executeWithRefresh(
  step, mappedPayload, credentials, idempotencyKey, unresolvedFields, isRetry
): Promise<StepRunResult> {
  const adapter = getAdapter(step.availableActionId!);
  const request = adapter.buildRequest(mappedPayload, credentials, idempotencyKey);

  try {
    const response = await axios({
      url: request.url,
      method: request.method,
      headers: request.headers,
      data: request.body,
      timeout: 30000,
    });

    const result = adapter.parseResponse(response.data);
    return { ...result, unresolvedFields };
```

**`timeout: 30000`** — 30-second axios timeout. Without this, a slow external API could hold
the worker thread indefinitely, blocking the Kafka batch from making progress (preventing
heartbeats) and eventually causing a session timeout rebalance.

**The adapter pattern:** `adapter.buildRequest()` takes the mapped payload and credentials and
returns an `AdapterRequest` (url, method, headers, body). This abstracts provider-specific
HTTP construction (Slack Bearer auth vs Razorpay Basic auth vs GitHub PAT) behind a unified
interface. `adapter.parseResponse()` converts the raw response body to `AdapterResult`.

### The 401 + OAuth refresh (Lines 147–161)

```typescript
if (axiosErr.response?.status === 401 && !isRetry) {
  if (credentials.type === 'oauth') {
    // Lazy refresh — 401 means nothing executed server-side
    await refreshToken(step.connectionId!);
    const newCredentials = await getCredentials(step.connectionId!);
    return executeWithRefresh(step, mappedPayload, newCredentials, idempotencyKey, unresolvedFields, true);
  }
  // API key — no refresh flow
  return {
    status: 'failed',
    errorCode: 'INVALID_API_KEY',
    errorMessage: 'Stored API key was rejected. Reconnect this app.',
    unresolvedFields,
  };
}
```

**Why "lazy" refresh?** OAuth access tokens expire (typically after 1 hour). Rather than
pre-emptively refreshing before every action, we attempt the action with the current token. If
the provider returns 401 (unauthorized), we know the token is expired and refresh it. This lazy
approach avoids unnecessary refresh requests when the token is still valid.

**`!isRetry`** — prevents infinite refresh loops. We only attempt one refresh. If the token
refresh fails or the second attempt returns 401, we fail the step.

**Why is 401 safe for retry?** A 401 response means the server rejected the request because of
auth failure. The request was NOT processed by the server — no action was taken, no resource was
created. This makes 401 the one HTTP error code where it's safe to retry without idempotency key.

**API key connectors:** There's no refresh flow for API keys. A 401 with an API key means the
key is wrong or revoked. The user must reconnect the app. We return `INVALID_API_KEY` immediately.

### The ambiguous network error set (Lines 109–119)

```typescript
const AMBIGUOUS_NETWORK_CODES = new Set([
  'ECONNABORTED',   // axios client timeout
  'ECONNRESET',     // connection reset mid-flight
  'ETIMEDOUT',      // socket-level timeout
  'ENOTFOUND',      // DNS failure (may be transient)
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);
```

**Why these specific codes?**

- `ECONNABORTED` — axios's `timeout: 30000` fired. The request was sent but no response came
  within 30 seconds. The server may have received and processed the request.
- `ECONNRESET` — the server or a network node reset the TCP connection mid-flight. The server
  may have received the request before resetting.
- `ETIMEDOUT` — socket-level timeout (different from axios's application-level timeout). Same
  ambiguity.
- `ENOTFOUND` — DNS resolution failed. This means we couldn't connect at all — the request was
  NOT sent. But DNS failures can be transient (DNS server glitch), so we treat it as ambiguous
  to be safe.

For `status >= 500` (server errors): The server returned an error response, which means the
server received the request. Whether the server processed it before returning 500 is unknown.
Treating these as ambiguous prevents double-execution on retry.

For `status >= 400 < 500` (client errors): The server definitely received the request and
explicitly rejected it (bad request, unauthorized, etc.). These are definitive failures — the
request was NOT processed. Safe to return `'failed'` and potentially retry.

---

## 8. `engine/template-substitution.ts` — Type-Preserving Template Engine

**File:** `apps/worker/src/engine/template-substitution.ts`

```typescript
const TEMPLATE_REGEX = /\{\{([^}]+)\}\}/g;
```

This regex matches `{{anything}}`. The capture group `([^}]+)` matches one or more characters
that are not `}`. The `/g` flag means find all matches (not just the first).

### The single-token optimization (Lines 36–42)

```typescript
function substituteValue(template, context) {
  if (typeof template !== 'string') {
    return { value: template, resolved: true }; // Numbers, booleans pass through
  }

  const singleTokenMatch = template.match(/^\{\{([^}]+)\}\}$/);
  if (singleTokenMatch) {
    const path = singleTokenMatch[1].trim();
    const { value, found } = resolvePath(context, path);
    return { value: found ? value : null, resolved: found };
  }
```

**The critical type-preservation insight:** Consider a step config:
```json
{ "amount": "{{step_1.amount}}" }
```

The entire value `"{{step_1.amount}}"` is a single template token. The `step_1.amount` field in
the context might be the integer `5000`.

With naive string interpolation: `"{{step_1.amount}}".replace(regex, ...)` → `"5000"` (string).
The downstream API expects `amount` to be an integer for Razorpay's `create-payment` endpoint.
Sending `"5000"` (string) would cause an API validation error.

With single-token detection: The entire string is a single `{{token}}`. We look up the path,
get the native value `5000` (integer), and return it directly without stringification. The
`mappedPayload` gets `{ amount: 5000 }` with the correct type.

This distinction — "entire value is a template" vs "value contains embedded templates" — is the
difference between type-safe and type-unsafe template substitution.

### Mixed string interpolation (Lines 44–55)

```typescript
const result = template.replace(TEMPLATE_REGEX, (_match, path: string) => {
  const { value, found } = resolvePath(context, path.trim());
  if (!found) {
    allResolved = false;
    return ''; // Unresolved → empty string in mixed context
  }
  return String(value); // Stringify for embedding in mixed text
});
```

For `"Payment {{step_1.amount}} from {{step_1.customer}}"`, each token is replaced with its
string representation. Type preservation is not possible here — the result is inherently a string
because it contains literal text outside the tokens. The `String(value)` call handles numbers,
booleans, and objects uniformly.

---

## 9. `engine/payload-validator.ts` — Relaxed AJV Validation

**File:** `apps/worker/src/engine/payload-validator.ts`

```typescript
const ajv = new Ajv({ allErrors: true, coerceTypes: true });
```

**`allErrors: true`** — collect ALL validation errors, not just the first. This produces a
comprehensive error message showing everything that's wrong, not just the first mismatch.

**`coerceTypes: true`** — AJV will attempt type coercion. E.g., if the schema expects `number`
and the value is `"5000"` (string), AJV coerces it to `5000`. This is necessary because JSON
template substitution might produce string representations of numbers in edge cases.

### The relaxed schema builder (Lines 17–52)

```typescript
function relaxRequiredAndTypesFor(inputSchema, unresolvedFields) {
  if (unresolvedFields.length === 0) return schema; // No relaxation needed

  // Remove unresolved fields from required array
  if (Array.isArray(schema['required'])) {
    schema['required'] = schema['required'].filter(
      (field) => !unresolvedFields.includes(field),
    );
  }

  // For each unresolved field, allow null type
  for (const field of unresolvedFields) {
    if (properties[field]) {
      const fieldSchema = properties[field];
      const originalType = fieldSchema['type'];
      if (originalType) {
        fieldSchema['type'] = Array.isArray(originalType)
          ? [...originalType, 'null']
          : [originalType, 'null'];
      }
      fieldSchema['nullable'] = true;
    }
  }
```

**The problem this solves:** Imagine a Slack action that requires both `channel` and `text`.
The user's config:
```json
{
  "channel": "#alerts",
  "text": "{{step_1.optional_field}}"
}
```

`step_1.optional_field` might not exist in the payload (optional webhook field). After template
substitution: `{ "channel": "#alerts", "text": null }`. The JSON Schema says `text` is `required`
and must be `string`. AJV would fail validation with "text must be string (got null)".

**But we should not fail the action.** The `channel` field is correctly mapped. The `text` field
is null because the template reference didn't resolve — this might be intentional for optional
fields.

The relaxed schema does two things:
1. **Removes `text` from `required`** — so null `text` doesn't fail as "required field missing."
2. **Adds `null` to `text`'s type** — so `null` passes type validation for the `text` field.

This means the step will proceed and send `{ "channel": "#alerts", "text": null }` to Slack. The
Slack API will return an error about `text` being null — but this will be caught as a `failed`
status (Slack returns `{"ok": false, "error": "no_text"}`), which is better than failing at
validation with a confusing "validation failed" error that doesn't tell the user the actual issue.

---

## 10. `engine/filter-evaluator.ts` — Filter Step Logic

**File:** `apps/worker/src/engine/filter-evaluator.ts`

### The operator set

```typescript
type Operator = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'exists';
```

Eight operators covering equality, inequality, substring, numeric comparisons, and existence.

### Intentional type coercion in `eq` (Lines 38–43)

```typescript
case 'eq':
  // Explicit String coercion: "100" == 100 is intentional
  return String(actual) === String(condition.value);
case 'neq':
  return String(actual) !== String(condition.value);
```

**Why coerce to string for equality?** Webhook payloads are JSON, but JSON number types can be
unreliable across providers. Razorpay might send `"amount": 5000` (number), while a generic
webhook might send `"amount": "5000"` (string). A user configuring a filter `amount eq 5000`
should not need to worry about whether the webhook sends a number or a string.

**`String(actual) === String(condition.value)`** — both sides are coerced to strings before
comparison. `String(5000) === String("5000")` → `"5000" === "5000"` → `true`. The comment in
the code explicitly documents this intentionality.

### The `AND`/`OR` logic (Lines 78–83)

```typescript
const logic = config.logic ?? 'AND';
const results = config.conditions.map((c) => evaluateCondition(c, payloadContext));
return logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
```

**`every` vs `some`:** `AND` uses `every` (all conditions must be true). `OR` uses `some` (at
least one condition must be true). These are standard JavaScript array methods that short-circuit:
`every` stops at the first `false`, `some` stops at the first `true`.

Default is `AND` — the most common use case is "run only if ALL conditions are met."

---

## 11. `lib/resolve-path.ts` — Dot-Notation Path Resolver

**File:** `apps/worker/src/lib/resolve-path.ts`

```typescript
export function resolvePath(
  obj: unknown,
  path: string,
): { value: unknown; found: boolean } {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { value: undefined, found: false };
    }
    current = (current as Record<string, unknown>)[part];
  }

  return { value: current, found: current !== undefined };
}
```

**The `found` distinction:** We return `{ value, found }` instead of just `value`. This is
critical for distinguishing between:
- `{ value: null, found: true }` — the path exists and its value is `null`.
- `{ value: undefined, found: false }` — the path doesn't exist.

If we returned just `value`, both cases would return `undefined` (since `null` in most contexts
is falsy and you'd need to check `value === null`). The `found` boolean makes the distinction
explicit.

**Traversal:** `path = "payload.payment.entity.amount"` → `parts = ["payload", "payment",
"entity", "amount"]`. The loop walks the object one key at a time. At each step, if the current
value is null, undefined, or not an object, the path is not found.

**Shared by two modules:** Both `filter-evaluator.ts` and `template-substitution.ts` import
`resolvePath`. This is the correct abstraction — the path resolution logic is identical in both
contexts.

---

## 12. `services/rate-limiter.service.ts` — Redis Token Bucket

**File:** `apps/worker/src/services/rate-limiter.service.ts`

### The atomic Lua script (Lines 20–26)

```typescript
const ATOMIC_INCR_EXPIRE = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;
```

**The problem with non-atomic INCR + EXPIRE:**

```
# Non-atomic (broken)
Worker A: INCR ratelimit:conn:42 → 1 (first request)
Worker A: EXPIRE ratelimit:conn:42 60 → sets TTL
Worker B: INCR ratelimit:conn:42 → 2

This seems fine. But what if the process crashes between INCR and EXPIRE?
Worker A: INCR ratelimit:conn:42 → 1 (first request)
[CRASH]
# Key exists but has no TTL — it lives forever
# The rate limit window never resets
# The connection is permanently throttled
```

**The Lua script solution:** Redis executes Lua scripts atomically — no other commands can run
between the `INCR` and `EXPIRE` calls. The script:
1. `INCR key` → returns the new count.
2. If count == 1 (this is the first request in this window), set the TTL.
3. If count > 1 (key already exists and has a TTL), don't reset the TTL.

**Why `if count == 1`?** We only set the TTL on the first increment. If we set it on every
increment, the window would keep sliding — each request would reset the TTL, preventing it from
ever expiring. We want a fixed window that resets after `windowSeconds`.

### `checkAndConsume` (Lines 33–42)

```typescript
export async function checkAndConsume(
  connectionId: bigint,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = `ratelimit:${connectionId}`;
  const count = await client.eval(ATOMIC_INCR_EXPIRE, 1, key, String(windowSeconds)) as number;
  return count <= limit;
}
```

**`client.eval(script, numkeys, key, ...args)`** — runs the Lua script. `1` is the number of
keys (KEYS array length). `key` goes into `KEYS[1]`. `String(windowSeconds)` goes into `ARGV[1]`.

**Consume before check:** We increment first, then check. This means the rate limit is consumed
even if we're over the limit. Is this a problem? No — if we're over the limit, we return `false`
and the step returns `processing`. No actual API call is made. The Redis counter was bumped, but
we'll reset to 0 when the window expires anyway.

### `underRunCap` — Per-Zap Hourly Cap (Lines 44–54)

```typescript
export async function underRunCap(zapId: bigint, cap: number): Promise<boolean> {
  const hourBucket = Math.floor(Date.now() / 3600000);
  const key = `runcap:${zapId}:${hourBucket}`;
  const count = await client.eval(ATOMIC_INCR_EXPIRE, 1, key, '3600') as number;
  return count <= cap;
}
```

**`hourBucket = Math.floor(Date.now() / 3600000)`** — divides the current Unix timestamp (ms)
by milliseconds-per-hour, then floors to an integer. This produces a consistent integer for the
current hour: `1728738400000 / 3600000 = 480205.1... → 480205`. All runs within the same hour
have the same `hourBucket`. The key changes hourly, and the TTL of 3600 seconds ensures the key
expires at most one hour after the bucket changes.

**Different from `checkAndConsume`:** `checkAndConsume` is per-connection, per-window. `underRunCap`
is per-zap, per-hour. They serve different purposes:
- `checkAndConsume`: Prevents a single connection from hitting external API rate limits.
- `underRunCap`: Protects the system from runaway zaps that loop infinitely.

---

## 13. `services/token-refresh.service.ts` — OAuth Credential Management

**File:** `apps/worker/src/services/token-refresh.service.ts`

### `getCredentials` (Lines 14–33)

```typescript
export async function getCredentials(connectionId: bigint): Promise<Credentials> {
  const connection = await prisma.connection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { connector: { select: { authType: true } } },
  });

  if (connection.connector.authType === 'api_key') {
    return {
      type: 'api_key',
      apiKey: decrypt(connection.apiKey!),
      apiSecret: connection.apiSecret ? decrypt(connection.apiSecret) : null,
    };
  }

  return {
    type: 'oauth',
    accessToken: decrypt(connection.accessToken!),
    refreshToken: decrypt(connection.refreshToken!),
  };
}
```

**`findUniqueOrThrow`** — throws a `PrismaClientKnownRequestError` if not found. This is
preferable to `findUnique` (which returns null) because a missing connection at execution time
is a programming error — the executor should have verified connectivity before reaching this
point. Throwing surfaces the error clearly.

**Discriminated union return type:** `Credentials = { type: 'oauth', ... } | { type: 'api_key',
... }`. The `type` discriminant allows the connector adapter and step runner to safely access
credential fields with type narrowing: `if (credentials.type === 'oauth') { credentials.accessToken }`.

### `refreshToken` (Lines 42–84)

```typescript
export async function refreshToken(connectionId: bigint): Promise<void> {
  ...
  const oauthConfigs = env.OAUTH_CLIENT_CONFIGS
    ? (JSON.parse(env.OAUTH_CLIENT_CONFIGS) as Record<string, { clientId?: string; clientSecret?: string }>)
    : {};
  const clientCreds = oauthConfigs[connection.connector.id] ?? {};

  const params = new URLSearchParams({
    refresh_token: storedRefreshToken,
    grant_type: 'refresh_token',
  });
  if (clientCreds.clientId) params.set('client_id', clientCreds.clientId);
  if (clientCreds.clientSecret) params.set('client_secret', clientCreds.clientSecret);

  const response = await axios.post(tokenUrl, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
```

**RFC 6749 §6 compliance:** The OAuth 2.0 refresh token grant requires:
- `grant_type: 'refresh_token'`
- `refresh_token: <stored refresh token>`
- Some providers require `client_id` and `client_secret` in the request body (not all).

`OAUTH_CLIENT_CONFIGS` is a JSON environment variable that maps connector IDs to client
credentials: `{"slack": {"clientId": "...", "clientSecret": "..."}}`. This allows per-provider
OAuth client credentials without hardcoding them in the codebase.

**`Content-Type: application/x-www-form-urlencoded`** — OAuth token endpoints require
form-encoded bodies, not JSON. `URLSearchParams` handles the encoding. `axios.post(url, params)`
with a `URLSearchParams` body automatically sets the correct Content-Type... but we set it
explicitly to be safe.

```typescript
  await prisma.connection.update({
    where: { id: connectionId },
    data: {
      accessToken: encrypt(data.access_token),
      ...(data.expires_in && {
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
      }),
    },
  });
```

**Update only `accessToken`, not `refreshToken`:** Most OAuth providers issue a new `access_token`
on refresh but NOT a new `refresh_token` (the refresh token is long-lived). Only if the provider
returns a new `refresh_token` in the response should it be updated. Our current implementation
doesn't update the refresh token — if a provider rotates them, this would need to be updated.

**`data.expires_in * 1000`** — OAuth `expires_in` is in seconds. JavaScript `Date` expects
milliseconds. `Date.now() + data.expires_in * 1000` is the absolute expiry timestamp.

---

## 14. `services/encrypt.helper.ts` — AES-256-GCM At-Rest Encryption

**File:** `apps/worker/src/services/encrypt.helper.ts`

```typescript
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // 96 bits — NIST recommended for GCM
const TAG_LENGTH = 16; // 128-bit authentication tag
```

**Why AES-256-GCM?** GCM (Galois/Counter Mode) provides both confidentiality AND authenticity.
Unlike AES-CBC (which only provides confidentiality), AES-GCM's authentication tag detects if
the ciphertext was tampered with. If someone modifies the encrypted token in the DB, decryption
will throw an error rather than returning garbage plaintext. For storing OAuth tokens, this
tamper-detection is critical.

### `encrypt` (Lines 12–19)

```typescript
export function encrypt(plaintext: string): string {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}
```

**The storage format:** `[12 bytes IV][16 bytes GCM auth tag][N bytes ciphertext]`, base64-encoded.

- **Random IV:** `crypto.randomBytes(IV_LENGTH)` generates a fresh 12-byte IV for every
  encryption call. Never reuse IVs with GCM — reusing an IV with the same key breaks both
  confidentiality and authenticity. By generating random IVs, each encrypted token is unique
  even if the plaintext is the same.

- **IV stored with ciphertext:** The IV is prepended to the ciphertext. This is not a security
  issue — IVs are not secret. They just need to be unique. The decryptor reads the IV from the
  first 12 bytes.

- **Auth tag:** `cipher.getAuthTag()` must be called AFTER `cipher.final()`. The 16-byte GCM
  auth tag covers both the ciphertext and any associated data (we don't use associated data here).

### `decrypt` (Lines 25–34)

```typescript
export function decrypt(encoded: string): string {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, IV_LENGTH);            // First 12 bytes
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);  // Next 16 bytes
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);       // Rest
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
}
```

**`setAuthTag(tag)`** — tells the decipher to verify this auth tag when `final()` is called. If
the tag doesn't match (ciphertext was tampered with, wrong key, wrong IV), `final()` throws
`"Unsupported state or unable to authenticate data"`. This is the tamper detection in action.

**`ENCRYPTION_KEY`** — must be a 32-byte (256-bit) key stored as a 64-character hex string in
the environment. Generated with `openssl rand -hex 32`. This key is the single secret protecting
all OAuth tokens and API keys in the database. If this key is compromised, all stored credentials
must be rotated.

---

*Continue to: [DD4 — Background Jobs, Cron, and Sentry Alerting](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD4_JOBS_AND_SENTRY.md)*
