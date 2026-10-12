# Deep Dive 4 — Background Jobs, Cron, and Sentry Alerting: Every Line Explained

> This chapter covers all five self-healing background jobs: what they heal, when they run,
> how they detect anomalies, and exactly how Sentry integration works. It also covers the
> connector adapter system, the App API management layer, and the complete test suite.

---

## Table of Contents

1. [The Five Background Jobs — Overview](#1-the-five-background-jobs--overview)
2. [`recover-dispatched-outbox.job.ts` — Relay Crash Recovery](#2-recover-dispatched-outboxjobts--relay-crash-recovery)
3. [`stuck-outbox-alert.job.ts` — Worker Processing Anomaly Alert](#3-stuck-outbox-alertjobts--worker-processing-anomaly-alert)
4. [`outbox-cleanup.job.ts` — Storage Hygiene](#4-outbox-cleanupjobts--storage-hygiene)
5. [`refresh-expiring-tokens.job.ts` — Proactive OAuth Token Renewal](#5-refresh-expiring-tokensjobts--proactive-oauth-token-renewal)
6. [`retry-stuck-steps.job.ts` (worker) — Rate-Limit Recovery](#6-retry-stuck-stepsjobts-worker--rate-limit-recovery)
7. [Sentry Integration Architecture](#7-sentry-integration-architecture)
8. [Connector Adapters: The Unified Interface](#8-connector-adapters-the-unified-interface)
9. [`app-api`: Management Layer Line-by-Line](#9-app-api-management-layer-line-by-line)
10. [The Complete Test Suite](#10-the-complete-test-suite)

---

## 1. The Five Background Jobs — Overview

No distributed system is perfectly reliable. The five background jobs are Zappy's **self-healing
layer** — each one detects a specific failure mode and corrects it automatically:

| Job | Service | Schedule | Heals |
|-----|---------|----------|-------|
| `recoverDispatchedOutbox` | app-api | Every 10 min | Relay crash between TX commit and Kafka produce |
| `stuckOutboxAlert` | app-api | Every 5 min | Worker consumed Kafka but never marked outbox consumed |
| `outboxCleanup` | app-api | Daily at midnight | Storage bloat from consumed outbox rows |
| `refreshExpiringTokens` | app-api | Every 15 min | OAuth tokens expiring while idle |
| `retryStuckSteps` | worker | Every 2 min | Steps stuck at 'processing' due to rate limiting |

**All jobs use `node-cron`.** The cron schedule syntax is standard Unix cron: `*/10 * * * *` means
"at every minute that is a multiple of 10" (every 10 minutes). `0 0 * * *` means "at 00:00 on
every day."

**Why are 4 of the 5 jobs in `app-api` and not in a dedicated cron service?** Pragmatic
deployment simplification. The `app-api` process is always running (it serves user HTTP requests).
Adding crons to it avoids needing to run a fifth service just for background jobs. In a production
system with very high throughput, these would be extracted to a dedicated worker or a managed cron
service (e.g., Cloud Scheduler on GCP).

---

## 2. `recover-dispatched-outbox.job.ts` — Relay Crash Recovery

**File:** `apps/app-api/src/jobs/recover-dispatched-outbox.job.ts`

```typescript
import * as Sentry from '@sentry/node';
```

**First non-trivial observation:** This is the first file (besides Sentry's init module) that
imports `@sentry/node` directly. The `recover-dispatched-outbox` job calls Sentry methods
directly because it detects anomalies that require immediate attention.

```typescript
const STUCK_MINUTES = 15;

export function startRecoverDispatchedOutboxJob(): void {
  cron.schedule('*/10 * * * *', async () => {
    try {
      const threshold = new Date(Date.now() - STUCK_MINUTES * 60 * 1000);

      const result = await prisma.outbox.updateMany({
        where: {
          status: 'dispatched',
          createdAt: { lt: threshold },
        },
        data: { status: 'pending' },
      });
```

**What "stuck at dispatched" means:** An outbox row has `status = 'dispatched'` set by the relay
daemon's transaction. This means the relay committed the DB transaction but then either:

- **Scenario A:** The relay process crashed before calling Kafka's `producer.send()`.
- **Scenario B:** The relay called `producer.send()`, Kafka acked, but then the relay crashed
  before returning from `produceRow()`. In this case the row should eventually be consumed by
  the worker and marked `consumed`. But if the Kafka message was lost (e.g., Kafka leader
  election, topic misconfiguration), the row stays `dispatched` forever.

**Why threshold = 15 minutes?** Normal relay flow: relay polls, claims rows (marks dispatched),
produces to Kafka, and moves on. The total time from `dispatched` to `consumed` is:
- Kafka produce: ~50ms
- Kafka message delivery to worker: ~50ms
- Worker processing: up to 2 minutes (complex zap with many steps)
- Worker marks outbox `consumed`: immediate

Total expected time: 2-3 minutes max. 15 minutes is 5× the expected maximum — a generous buffer
before we declare the row "stuck."

**The fix:** `updateMany({ status: 'pending' })` resets stuck rows to `pending`. The relay's next
poll sweep picks them up and re-dispatches them. The relay will try Kafka again.

**`createdAt: { lt: threshold }`** — we use `createdAt` as the stuck detection timestamp. Ideally
we'd use a `dispatchedAt` timestamp (when the row was marked `dispatched`), but the outbox schema
doesn't have that field. Using `createdAt` is slightly less precise (a row created 14 minutes ago
and dispatched 1 minute ago would be missed), but it's good enough for the purpose.

```typescript
      if (result.count > 0) {
        const message = `[recovery] Reset ${result.count} stuck 'dispatched' outbox row(s) to 'pending'`;
        logger.warn({ count: result.count }, message);
        if (process.env.SENTRY_DSN) {
          Sentry.captureMessage(message, 'warning');
        }
      }
    } catch (err) {
      logger.error({ err }, '[cron] recover-dispatched-outbox failed');
      Sentry.captureException(err);
    }
```

**`if (process.env.SENTRY_DSN)`** — guard before Sentry calls. If Sentry is not configured (no
DSN), `Sentry.captureMessage` would no-op anyway. The guard makes the intent explicit: Sentry
alerts are optional and only sent when a DSN is configured.

**Severity: `'warning'`** — in Sentry, messages have severity levels (`debug`, `info`,
`warning`, `error`, `fatal`). Recovery events are `warning` because they indicate a past anomaly
that was auto-corrected. They don't require immediate action but should be investigated.

**`Sentry.captureException(err)`** in the catch — if the cron job itself fails (e.g., DB is
down), capture the exception as an error-level Sentry event. This ensures cron failures are
monitored even when the cron's internal try/catch runs.

---

## 3. `stuck-outbox-alert.job.ts` — Worker Processing Anomaly Alert

**File:** `apps/app-api/src/jobs/stuck-outbox-alert.job.ts`

```typescript
const STUCK_THRESHOLD_MINUTES = 30;

export function startStuckOutboxAlertJob(): void {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const threshold = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);
      const stuck = await prisma.outbox.findMany({
        where: {
          status: 'dispatched',
          createdAt: { lt: threshold },
        },
        select: { id: true, eventId: true, createdAt: true, attempts: true },
      });
```

**Wait — this also queries `dispatched` rows after a threshold. How is this different from
`recoverDispatchedOutbox`?**

The two jobs serve different purposes with different thresholds:

- **`recoverDispatchedOutbox` (15 min, resetss to pending):** Handles the common case — relay
  crashed before Kafka produce. Automatically fixes it. Runs every 10 min.

- **`stuckOutboxAlert` (30 min, alerts only, no fix):** Handles the alarming case — the Kafka
  message WAS produced (worker consumed it), but the worker never marked the outbox row as
  `consumed`. This means the worker received the Kafka message and started processing, but
  something went very wrong. The `recoverDispatchedOutbox` job would reset these rows to
  `pending` → relay would re-dispatch → Kafka sends another message → worker gets a duplicate.

At 30 minutes, if a row is still `dispatched`, it means even the 15-minute recovery job ran
twice and the row keeps getting stuck. This is a systemic issue requiring human investigation.
The alert job does NOT fix — it only signals.

```typescript
      if (stuck.length > 0) {
        const message = `[ALERT] ${stuck.length} outbox row(s) stuck at 'dispatched' for >${STUCK_THRESHOLD_MINUTES}min. Manual intervention required.`;
        const stuckDetails = stuck.map((r) => ({
          id: r.id.toString(),
          eventId: r.eventId,
          attempts: r.attempts,
        }));
        logger.error({ stuckDetails }, message);

        if (process.env.SENTRY_DSN) {
          Sentry.captureMessage(message, 'error');
          Sentry.captureMessage(
            `Stuck outbox details: ${JSON.stringify(stuckDetails)}`,
            'warning',
          );
        }
      }
```

**Two Sentry messages:** The first is a high-level `error`-level alert with the count. The second
is a `warning`-level message with the full details (IDs, eventIds, attempts). Why two separate
messages? Sentry aggregates similar messages — if the same message is sent 10 times, Sentry shows
it once with a count. By separating the summary from the detail, we get the summary as a
persistent alert and the details as separate diagnostic context.

**`logger.error`** — using `error` level for stuck rows so they appear in error-level log queries.
This is appropriate — a stuck outbox row represents a failed pipeline.

---

## 4. `outbox-cleanup.job.ts` — Storage Hygiene

**File:** `apps/app-api/src/jobs/outbox-cleanup.job.ts`

```typescript
export function startOutboxCleanupJob(): void {
  cron.schedule('0 0 * * *', async () => {
    logger.info('[cron] Running outbox cleanup...');
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const result = await prisma.outbox.deleteMany({
        where: {
          status: 'consumed',
          createdAt: { lt: cutoff },
        },
      });
      logger.info({ count: result.count }, '[cron] Outbox cleanup complete');
    } catch (err) {
      logger.error({ err }, '[cron] outbox-cleanup failed');
    }
  });
}
```

**Why only delete `consumed` rows?** Each status has a different meaning:

- `pending` — waiting to be dispatched. Must not delete.
- `dispatched` — relay in flight. Must not delete.
- `consumed` — worker finished. Safe to delete after retention period.
- `dead` — failed permanently. Must NOT delete — these are evidence for investigation.

**7 days retention:** `7 * 24 * 60 * 60 * 1000` ms = 7 days. Consumed rows older than 7 days are
deleted. This is a balance between:
- Short retention (aggressive delete) → less storage, but less audit trail.
- Long retention (keep forever) → more storage, but full history.

7 days is enough for debugging recent issues. For longer audit requirements, these rows should
be archived to a data warehouse before deletion.

**`0 0 * * *`** — midnight daily. Chosen to minimize DB load during off-peak hours. If the outbox
has millions of consumed rows (high-traffic deployment), a large DELETE can lock the table briefly.
Running at midnight reduces the chance of this overlapping with active webhook processing.

**No Sentry on failure** — the cleanup job failure is logged as an error but not sent to Sentry.
A failed cleanup is not an operational emergency — the data will be cleaned up on the next run.
The `stuck-outbox-alert` job (which DOES use Sentry) handles actual operational emergencies.

---

## 5. `refresh-expiring-tokens.job.ts` — Proactive OAuth Token Renewal

**File:** `apps/app-api/src/jobs/refresh-expiring-tokens.job.ts`

```typescript
export function startRefreshExpiringTokensJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    const threshold = new Date(Date.now() + 30 * 60 * 1000); // 30 min from NOW
    const expiring = await prisma.connection.findMany({
      where: {
        expiresAt: { lte: threshold, gt: new Date() },
        accessToken: { not: null },
      },
      select: { id: true, connectorId: true },
    });

    for (const conn of expiring) {
      try {
        await refreshAccessToken(conn.id);
      } catch (err) {
        logger.error({ err, connectionId: conn.id.toString() }, '[cron] Failed to refresh token');
      }
    }
  });
}
```

**The two-layer token refresh strategy:**

1. **Lazy refresh (primary):** When the worker executes a step and gets 401, it refreshes the
   token and retries. This is the guaranteed layer — no token ever stays expired during active
   use.

2. **Proactive refresh (backup):** This cron job finds tokens expiring within 30 minutes and
   refreshes them before they expire. This prevents the 401 scenario entirely for active
   connections.

**Why proactive refresh if lazy refresh handles it anyway?** Two reasons:

1. **User experience:** If a connection's token expires at 3:00 PM and a webhook fires at 3:01
   PM, the lazy refresh adds an extra round-trip (verify token → 401 → refresh → retry). This
   adds 200-500ms to execution time. The proactive refresh eliminates this overhead for
   "foreseeable" expirations.

2. **Idle connections:** If a user hasn't triggered any webhooks for 60+ days and their OAuth
   token expired, the refresh token itself might expire (many providers expire refresh tokens
   after 90 days of inactivity). Proactive refresh keeps both tokens alive. The lazy refresh
   would only trigger when a webhook fires — potentially too late if the refresh token has also
   expired.

**`expiresAt: { lte: threshold, gt: new Date() }`** — finds connections where:
- `expiresAt <= now + 30 minutes` (expiring within 30 minutes) AND
- `expiresAt > now` (not yet expired — if already expired, the lazy refresh handles it at
  execution time; trying to refresh an already-expired token might fail due to provider quirks)

**`for (const conn of expiring)`** — sequential processing. We don't use `Promise.all` here
because refreshing many tokens simultaneously could rate-limit the OAuth provider (too many
token refresh requests in a short window).

**`try/catch` per connection** — if one connection's refresh fails (e.g., the user revoked access),
we log the error but continue to the next connection. A single failure doesn't block all other
token refreshes.

---

## 6. `retry-stuck-steps.job.ts` (worker) — Rate-Limit Recovery

**File:** `apps/worker/src/services/retry-stuck-steps.job.ts`

```typescript
const RETRY_AFTER_MINUTES = 2;

export async function retryStuckSteps(): Promise<void> {
  const cutoff = new Date(Date.now() - RETRY_AFTER_MINUTES * 60 * 1000);

  const stuckSteps = await prisma.zapRunStep.findMany({
    where: {
      status: 'processing',
      claimedAt: { lt: cutoff },
    },
    select: { id: true, zapRunId: true },
    take: 50,
  });
```

**Why does this job exist?** When a step is rate-limited, `step-runner.ts` returns `{ status:
'processing' }` and the sequential executor returns early. The step stays in `processing` status.
But the run is also `in_progress`. Without this job, the run stays `in_progress` forever — there
is no mechanism to re-trigger the executor.

**`claimedAt: { lt: cutoff }`** — finds steps whose `claimedAt` is older than 2 minutes. Why
`claimedAt` and not `createdAt`? Because `claimedAt` is refreshed by `releaseWithDelay()` when a
rate-limited step is left in processing. A step that was rate-limited 5 minutes ago and had its
lease refreshed 1 minute ago would have `claimedAt = 1 minute ago`. We don't want to reset it
yet — it just had its lease refreshed. Using `claimedAt < cutoff` (2 minutes ago) gives a 2-
minute window from the last lease refresh.

**`take: 50`** — processes at most 50 stuck steps per run. Prevents the cron from doing massive
batch updates if there's a backlog. Next cron run picks up the next 50.

```typescript
  const ids = stuckSteps.map((s) => s.id);
  const zapRunIds = [...new Set(stuckSteps.map((s) => s.zapRunId))];

  await prisma.$transaction([
    prisma.zapRunStep.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'failed',
        errorCode: 'RATE_LIMIT_RETRY',
        errorMessage: 'Retried after rate-limit window expired',
      },
    }),
    prisma.zapRun.updateMany({
      where: { id: { in: zapRunIds }, status: 'in_progress' },
      data: { status: 'in_progress' },
    }),
  ]);
```

**Why mark steps as `failed` instead of resetting to `processing`?**

The sequential executor's `claim()` function uses `INSERT ... ON CONFLICT DO NOTHING`. It won't
re-claim a step that already has a `zap_run_steps` row. If we reset the step to `processing`
(from `processing`), the next executor call would still see a conflict on INSERT and back off.

By marking as `failed` → the next time the executor is triggered for this run, it calls
`claim()` for the step's position. The INSERT finds no conflict (the step row's status doesn't
prevent a new claim — the ON CONFLICT is on the unique key, not the status). Wait — actually the
row already exists with a unique key. The executor would see `status: 'failed'` in the conflict
path and... actually the code in `claim()` only returns null for `status: 'completed'`. For
other statuses, it checks lease timeout. This means a `failed` step would be seen as "not
completed" and the lease check runs.

Actually, looking at the sequential executor more carefully: `resume()` calls `findMany` for
completed steps and calculates `maxCompletedPosition`. A `failed` step at position 2 is not
in the `completed` set. So the executor starts from `maxCompletedPosition + 1`. If position 1
is completed and position 2 failed, the executor starts at position 2. It tries to claim
position 2's step via `INSERT ON CONFLICT DO NOTHING`. The conflict fires (row exists). It
fetches the existing row. The row has `status: 'failed'` and `claimedAt` is fresh. The code
checks `status === 'completed'` → false. Then checks lease timeout → `claimedAt` is old enough.
So `reclaim()` fires — which marks the step `ambiguous`. This is wrong!

The note in the job file: "For full automatic retry, a relay-side job should re-enqueue the
zapRunId to Kafka." The current implementation resets stuck steps to `failed` but doesn't
actually re-trigger execution. This is a known limitation noted in the code comments. The manual
retry path is: Sentry alert → operator re-triggers via the management API.

**`[...new Set(...)]`** — deduplication. Multiple steps from the same run can be stuck. We want
to update the run status once, not once per stuck step.

**`prisma.$transaction([...])`** — batch transaction. Both the step update and run status update
happen atomically. If the step update succeeds but the run update fails, the transaction rolls
back both.

---

## 7. Sentry Integration Architecture

Sentry is used across all services for error tracking. Here's the complete architecture:

### Initialization

Each service initializes Sentry in its entry point, before any other code:

```typescript
// hooks-api/src/server.ts
import { initSentry } from './lib/sentry';
initSentry(); // Must be FIRST

// worker/src/main.ts
import { initSentry } from './lib/sentry';
initSentry(); // Must be FIRST

// relay/src/main.ts
import { initSentry } from './lib/sentry';
initSentry(); // Must be FIRST
```

### The Three Sentry Usage Patterns in This Codebase

**Pattern 1: `captureException(err)` — Unexpected Errors**
```typescript
// In cron jobs
} catch (err) {
  logger.error({ err }, '[cron] job failed');
  Sentry.captureException(err); // Full error with stack trace to Sentry
}
```
Used when an unexpected error occurs in a cron job. Sentry receives the full error object,
stack trace, and request context. Creates a Sentry "issue" that can be assigned and tracked.

**Pattern 2: `captureMessage(msg, severity)` — Anomaly Alerts**
```typescript
// In stuck-outbox-alert
Sentry.captureMessage(message, 'error');
```
Used for business-logic anomalies (stuck rows) that aren't JavaScript errors. These create
Sentry "issues" with the message as the title. The severity determines how urgently they appear.

**Pattern 3: `Sentry.flush(2000)` — Graceful Shutdown**
```typescript
// In app-api server.ts shutdown handler
await Sentry.flush(2000).catch(() => {});
```
Sentry batches events and sends them asynchronously. During graceful shutdown, in-flight events
might be dropped if the process exits before they're sent. `flush(2000)` waits up to 2 seconds
for pending events to be sent. `.catch(() => {})` — if flush times out, we ignore the error
and proceed with shutdown. We don't want Sentry to block a graceful shutdown.

### `tracesSampleRate: 0.1` — Performance Monitoring

Sentry can capture distributed traces (request-level performance data). With `0.1`, 10% of all
requests are sampled. Each trace shows:
- Time spent in route handler vs middleware vs DB query
- Time from webhook receipt to outbox write
- Time from Kafka message receipt to run completion

In production, this 10% sample is enough to identify performance regressions without the cost
of 100% tracing.

---

## 8. Connector Adapters: The Unified Interface

**File:** `apps/worker/src/connectors/registry.ts`

### The `ConnectorAdapter` contract

```typescript
export interface ConnectorAdapter {
  actionId: string;         // e.g. "slack:send-message"
  connectorId: string;      // e.g. "slack"
  supportsIdempotencyKey: boolean;
  buildRequest(
    mappedPayload: Record<string, unknown>,
    credentials: Credentials,
    idempotencyKey: string,
  ): AdapterRequest;
  parseResponse(rawResponse: unknown): AdapterResult;
}
```

**Why this interface?** The step runner is provider-agnostic. It knows nothing about Slack's
`chat.postMessage` API or Razorpay's Basic Auth. By programming to the `ConnectorAdapter`
interface, the step runner can execute any action with identical code:

```typescript
const adapter = getAdapter(step.availableActionId);   // Lookup
const request = adapter.buildRequest(...);             // Build
const response = await axios(request);                 // Send
const result = adapter.parseResponse(response.data);  // Parse
```

This is the **Adapter pattern** from Gang of Four. Adding a new connector means implementing
two functions (`buildRequest` and `parseResponse`) and calling `registerAdapter()`. No changes
to the step runner.

### Slack Adapter (Lines 11–61 of send-message.ts)

```typescript
export const slackSendMessageAdapter: ConnectorAdapter = {
  actionId: 'slack:send-message',
  connectorId: 'slack',
  supportsIdempotencyKey: false,  // Slack has no X-Idempotency-Key mechanism

  buildRequest(mappedPayload, credentials, _idempotencyKey): AdapterRequest {
    if (credentials.type !== 'oauth') {
      throw new Error('Slack requires OAuth credentials');
    }

    return {
      url: 'https://slack.com/api/chat.postMessage',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: {
        channel: mappedPayload['channel'] as string,
        text: mappedPayload['text'] as string,
      },
    };
  },

  parseResponse(rawResponse): AdapterResult {
    const data = rawResponse as SlackResponse;

    if (data.ok) {
      return {
        status: 'completed',
        output: { ok: data.ok, ts: data.ts, channel: data.channel },
      };
    }

    return {
      status: 'failed',
      errorCode: 'SLACK_API_ERROR',
      errorMessage: data.error ?? 'Unknown Slack error',
    };
  },
};
```

**`supportsIdempotencyKey: false`** — Slack's `chat.postMessage` API has no idempotency
mechanism. If the step runner times out while sending a message, we don't know if Slack received
it. This is why Slack steps are classified as `ambiguous` on network timeout — we can't safely
retry.

**Slack's response format:** Slack returns `{"ok": true, ...}` on success and `{"ok": false,
"error": "channel_not_found"}` on failure — always HTTP 200, with the success/failure in the
body. This is why `parseResponse` checks `data.ok` instead of looking at the HTTP status code.

**`data.ts` — the message timestamp.** Slack's message timestamp is the unique identifier for
a message. The output `{ ok, ts, channel }` is stored in the `zap_run_steps.output` JSONB field.
Users can see "Message sent to #alerts at timestamp 1728738400.123" in the execution log.

### Razorpay Adapter

```typescript
export const razorpayCreatePaymentAdapter: ConnectorAdapter = {
  supportsIdempotencyKey: true,  // Razorpay supports X-Idempotency-Key

  buildRequest(mappedPayload, credentials, idempotencyKey): AdapterRequest {
    // Razorpay uses HTTP Basic Auth: key_id:key_secret
    const basicAuth = Buffer.from(
      `${credentials.apiKey}:${credentials.apiSecret ?? ''}`,
    ).toString('base64');

    return {
      url: 'https://api.razorpay.com/v1/payment_links',
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: { amount: ..., currency: ..., description: ... },
    };
  },
};
```

**Basic Auth format:** `Authorization: Basic base64("key_id:key_secret")`. The `:` separator
between key and secret is standard HTTP Basic Auth. Razorpay uses the API key as the username
and the API secret as the password. `Buffer.from(str).toString('base64')` is safe because the
key and secret are ASCII strings (Razorpay uses alphanumeric keys).

**`X-Idempotency-Key`** — Razorpay uses this header to detect duplicate payment link creation
requests. If the same `idempotencyKey` is sent twice, Razorpay returns the result of the first
successful request without creating a second payment link. This is the server-side deduplication
that makes Razorpay safe to retry on timeout.

### GitHub Adapter

```typescript
return {
  url: `https://api.github.com/repos/${owner}/${repo}/issues`,
  method: 'POST',
  headers: {
    Authorization: `Bearer ${credentials.apiKey}`,  // PAT used as Bearer token
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github.v3+json',     // Explicit API version
    'User-Agent': 'Zapier-Clone-Worker',              // GitHub requires User-Agent
  },
```

**`Accept: application/vnd.github.v3+json`** — GitHub's REST API versioning via the `Accept`
header. Without this, GitHub returns v3 by default, but being explicit prevents future
breakage if GitHub changes the default. The `v3` API is stable and widely supported.

**`User-Agent: 'Zapier-Clone-Worker'`** — GitHub's API REQUIRES a `User-Agent` header and will
reject requests without one with a 403. Any string is acceptable.

**`credentials.apiKey` as Bearer token** — GitHub Personal Access Tokens (PATs) work as
Bearer tokens. The user creates a PAT in GitHub settings and stores it as an API key connection
in Zappy. The `api_key` credential type is used here (not OAuth), because PATs are static
credentials that don't expire or need refresh.

### The Registry

```typescript
const registry = new Map<string, ConnectorAdapter>();

export function registerAdapter(adapter: ConnectorAdapter): void {
  registry.set(adapter.actionId, adapter);
}

registerAdapter(slackSendMessageAdapter);
registerAdapter(razorpayCreatePaymentAdapter);
registerAdapter(githubCreateIssueAdapter);

export function getAdapter(actionId: string): ConnectorAdapter {
  const adapter = registry.get(actionId);
  if (!adapter) {
    throw new Error(`No adapter registered for actionId: ${actionId}`);
  }
  return adapter;
}
```

**`Map<string, ConnectorAdapter>`** — O(1) lookup by `actionId`. The key is the full action ID
(e.g., `"slack:send-message"`). The `Map` is module-level (singleton). It's populated at module
load time via the `registerAdapter()` calls at the bottom of the file (side-effect pattern).

**`throw new Error` in `getAdapter`** — if an action ID is not found, it's a configuration bug.
The error will propagate up to `step-runner.ts`, be caught by the try/catch, and result in a
`'failed'` step status with `'REQUEST_ERROR'` error code. The operator would see "No adapter
registered for actionId: unknown:action" in the step's error message.

---

## 9. `app-api`: Management Layer Line-by-Line

**File:** `apps/app-api/src/controllers/zap.controller.ts`

### The `serializeBigInt` problem (Line 9)

```typescript
import { serializeBigInt } from '../lib/serialize';
```

**The problem:** Prisma returns `bigint` for `BIGSERIAL` columns. JavaScript's `JSON.stringify`
doesn't support `bigint` natively — it throws `TypeError: Do not know how to serialize a BigInt`.
This would crash every API response that includes a zap ID.

**`serializeBigInt`** recursively walks a response object and converts all `bigint` values to
strings. `{ id: 42n, name: "My Zap" }` → `{ id: "42", name: "My Zap" }`. The frontend receives
strings for IDs, which is correct — JavaScript's `number` type can't represent 64-bit integers
accurately (loss of precision above 2^53).

### The Zod schema (Lines 16–30)

```typescript
const stepSchema = z.object({
  stepType: z.enum(['trigger', 'action', 'filter']),
  position: z.number().int().min(0),
  availableTriggerId: z.string().optional().nullable(),
  availableActionId: z.string().optional().nullable(),
  connectionId: z.string().optional().nullable(),
  config: z.record(z.unknown()).default({}),
});

const createZapSchema = z.object({
  name: z.string().min(1).max(200),
  isActive: z.boolean().default(true),
  maxRunsPerHour: z.number().int().min(1).max(10000).default(100),
  steps: z.array(stepSchema).min(1),
});
```

**Why Zod?** `z.parse(req.body)` does two things: (1) validates the input shape and types, (2)
transforms the input (applies defaults, coerces types). If validation fails, it throws a
`ZodError` with detailed error messages. The error handler middleware formats this into a 400
response.

**`z.string().optional().nullable()`** — allows the field to be:
- Absent from the request body (`optional`)
- Present but null (`nullable`)
- Present as a string

This accommodates the frontend sending `null` explicitly (e.g., clearing a connection) vs not
sending the field at all.

### Webhook Secret Concealment (Lines 71–86)

```typescript
const zap = await prisma.zap.findFirst({
  where: { id: zapId, userId },
  include: {
    steps: {
      orderBy: { position: 'asc' },
      // Explicitly select all fields except webhookSecret
      select: {
        id: true,
        zapId: true,
        stepType: true,
        position: true,
        availableTriggerId: true,
        availableActionId: true,
        connectionId: true,
        config: true,
        createdAt: true,
        availableTrigger: true,
        availableAction: true,
      },
    },
  },
});
```

**`webhookSecret` is NOT in the select list.** This is intentional and critical. The
`webhookSecret` is the HMAC signing key for the webhook. If it were included in the GET `/zap/:id`
response, it would be sent to the browser. The browser might log it, include it in error reports,
or expose it via XSS. The webhook secret is a cryptographic credential that must be treated like
a password.

**The dedicated secret endpoint:** There's a separate `GET /zaps/:id/steps/:stepId/secret`
endpoint (handled by `getWebhookSecret`) that returns the secret only when explicitly requested
by the authenticated owner. This endpoint is used by the dashboard to display the secret in
a "copy your webhook URL and secret" onboarding step.

### `assertConnectionOwnership` (Lines 108–113)

```typescript
for (const step of body.steps) {
  if (step.connectionId) {
    await assertConnectionOwnership(BigInt(step.connectionId), userId);
  }
}
```

**What IDOR is:** Insecure Direct Object Reference. If User A knows User B's `connectionId`
(perhaps by guessing sequential IDs or through another exploit), User A could create a zap that
uses User B's Slack credentials. The zap would execute using User B's OAuth token, sending
messages as User B.

**`assertConnectionOwnership`** prevents this: it verifies that the `connectionId` belongs to
the current `userId` before allowing it to be used in a zap. If the connection doesn't belong
to the user, it throws a 403 error.

**Why can't we rely on DB foreign keys?** The `zap_steps.connection_id` FK references
`connections.id`. But there's no FK that says "connections.user_id must equal zaps.user_id."
PostgreSQL can enforce referential integrity (the connection must exist) but not cross-table
ownership rules (the connection must belong to this user). Application-layer enforcement is
necessary.

### Atomic step resequencing (Lines 352–375)

```typescript
await prisma.$transaction(async (tx: PrismaTx) => {
  await tx.zapStep.delete({ where: { id: stepId } });

  const remaining = zap.steps
    .filter((s) => s.id !== stepId)
    .sort((a, b) => a.position - b.position);

  if (remaining.length > 0) {
    const values = remaining
      .map((s, i) => `(${s.id}::bigint, ${i})`)
      .join(', ');

    await tx.$executeRawUnsafe(`
      UPDATE zap_steps AS t
      SET position = v.new_pos
      FROM (VALUES ${values}) AS v(id, new_pos)
      WHERE t.id = v.id AND t.position != v.new_pos
    `);
  }
});
```

**The problem:** When step at position 1 is deleted from [0, 1, 2], positions become [0, 2].
The gap at position 1 violates the contiguous sequence rule. The sequential executor would skip
position 1 and never reach position 2.

**The SQL-level fix:** A single UPDATE using PostgreSQL's `VALUES` table-valued constructor:
```sql
UPDATE zap_steps AS t
SET position = v.new_pos
FROM (VALUES (101::bigint, 0), (103::bigint, 1)) AS v(id, new_pos)
WHERE t.id = v.id AND t.position != v.new_pos
```

This updates all positions in one query instead of N queries. The `AND t.position != v.new_pos`
guard prevents no-op updates (rows where position is already correct).

**`$executeRawUnsafe`** — note the `Unsafe` suffix. This variant allows string interpolation
in the SQL, making it vulnerable to SQL injection if `values` contains user-supplied data. But
here, `values` is constructed from `s.id` (bigint, not user input) and `i` (a loop counter).
Neither can contain malicious SQL. The use of `Unsafe` is justified but must be carefully
reviewed when modifying this code.

---

## 10. The Complete Test Suite

### `auth.controller.test.ts` — Unit Tests with Full Mocking

```typescript
vi.mock('@zapier-clone/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$hashed$'),
    compare: vi.fn(),
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('mock.jwt.token'),
    verify: vi.fn(),
  },
}));
```

**Why mock all three?** Unit tests test one unit in isolation. The auth controller's logic is:
"validate input → check if user exists → hash password → create user → sign JWT → return token."
We don't want the test to:
- Connect to a real Postgres database (slow, requires setup)
- Use the real bcrypt algorithm (slow — bcrypt is intentionally CPU-intensive)
- Sign real JWTs (requires valid secret key)

By mocking these modules with `vi.mock()`, the tests run in-process with no external
dependencies and complete in milliseconds.

**`vi.fn().mockResolvedValue('$hashed$')`** — creates a mock that returns a resolved Promise
with `'$hashed$'`. Simulates `bcrypt.hash()` returning a "hashed" password without doing actual
bcrypt computation.

```typescript
function makeMockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}
```

**`mockReturnThis()`** — makes `res.status(200)` return the mock `res` object (for method
chaining: `res.status(200).json({ ... })`). Without this, `res.status(200)` would return
`undefined`, and `.json({...})` would throw.

```typescript
it('creates user and returns token + user on success', async () => {
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null);    // No existing user
  vi.mocked(prisma.user.create).mockResolvedValue({
    id: 42n, name: 'Test User', email: 'new@example.com',
  } as any);

  const req = {
    body: { name: 'Test User', email: 'new@example.com', password: 'password123' },
  } as Request;
  const res = makeMockRes();
  await signup(req, res, next);

  expect(res.status).toHaveBeenCalledWith(201);
  const body = vi.mocked(res.json).mock.calls[0][0] as { token: string; user: { id: string } };
  expect(body.token).toBe('mock.jwt.token');
  expect(body.user.id).toBe('42');  // BigInt 42n serialized to string "42"
});
```

**`body.user.id === '42'`** — verifies the BigInt → string serialization. The mock returns
`id: 42n` (bigint). The controller must call `serializeBigInt()` before sending the response.
The test verifies the string `'42'`, not the bigint `42n`. This confirms the serialization
is working.

### `zap-validation.test.ts` — Pure Function Tests

```typescript
describe('validateZapSteps', () => {
  it('throws if no trigger step exists', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'action', position: 0, availableActionId: 'slack:send-message' },
      ]),
    ).toThrow('exactly one trigger');
  });

  it('throws if positions have gaps', () => {
    expect(() =>
      validateZapSteps([
        { stepType: 'trigger', position: 0, availableTriggerId: 'razorpay:payment.captured' },
        { stepType: 'action', position: 2, availableActionId: 'slack:send-message' }, // gap at 1
      ]),
    ).toThrow('contiguous');
  });
```

**`validateZapSteps` is a pure function** — it takes an array of steps and throws if any
validation rule is violated. No DB, no HTTP, no side effects. These tests run synchronously.

**What's being tested:**
- One trigger, always at position 0
- Contiguous positions (no gaps)
- No duplicate positions
- Trigger must have `availableTriggerId`, not `availableActionId`
- Action/filter steps must not have `availableTriggerId`

These invariants prevent invalid zap configurations from being created. They are enforced in
`zap.controller.ts` before any DB write.

### `pipeline.e2e.test.ts` — End-to-End Integration

```typescript
async function isPgReachable(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3001/health').catch(() => null);
    return res?.ok ?? false;
  } catch {
    return false;
  }
}

let SKIP = false;

beforeAll(async () => {
  SKIP = !(await isPgReachable());
  ...
}, 30_000);
```

**Auto-skip when stack isn't running:** The E2E tests require the full Docker Compose stack (app-
api, hooks-api, worker, relay, Postgres, Redis, Kafka). In CI without Docker, `isPgReachable()`
returns false, `SKIP = true`, and all tests exit immediately with `return` (not `skip()` — they
execute but return without running any assertions).

**`beforeAll` timeout of 30,000ms** — the signup API call in `beforeAll` can take up to 30
seconds on a cold Postgres+Node.js startup. The default Vitest timeout is 5 seconds — too short.

```typescript
function signPayload(payload: string, secret: string): string {
  const { createHmac } = require('crypto') as typeof import('crypto');
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}
```

**Test helper that mirrors hooks-api's HMAC logic.** The E2E test must sign the webhook payload
exactly as GitHub would — `sha256=<hex>`. This signature is verified by `hmac-verify.service.ts`
using the same algorithm. If the signature doesn't match, the webhook is rejected with 401.

```typescript
describe('8.4.2 Happy path: webhook → zap_run completed', () => {
  it('should complete a zap run end-to-end', async () => {
    // 1. Create a zap
    const zap = await apiPost<ZapResponse>('/zaps', { name: '...', steps: [...] }, authToken);
    
    // 2. Get the webhook secret
    const zapData = await apiGet<ZapResponse>(`/zaps/${zapId}`, authToken);
    const webhookSecret = triggerStep?.webhookSecret;
    
    // 3. Fire a signed webhook
    const signature = signPayload(payloadStr, webhookSecret!);
    const webhookRes = await fetch(`${HOOKS_BASE}/hooks/${zapId}/${stepId}`, { ... });
    expect(webhookRes.ok).toBe(true);
    
    // 4. Poll for completion (up to 15 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      const data = await apiGet<RunsResponse>(`/zaps/${zapId}/runs?page=1`, authToken);
      if (['completed', 'failed', 'filtered'].includes(run.status)) break;
    }
    
    expect(['completed', 'filtered']).toContain(run!.status);
  }, 30_000);
});
```

**This test exercises the complete pipeline:**
1. User auth (signup → JWT)
2. Zap creation (app-api CRUD)
3. Webhook secret retrieval (separate endpoint)
4. Webhook ingestion (hooks-api, HMAC verification, outbox write)
5. Relay dispatch (outbox → Kafka)
6. Worker consumption (Kafka → sequential execution)
7. Run status polling (app-api reads DB state)

**The polling loop** — the test doesn't know how long the worker will take. It polls every 500ms
for up to 15 seconds (30 × 500ms). This is intentionally loose — the goal is to verify the
pipeline completed, not to verify timing.

**`['completed', 'filtered']` — why not just `'completed'`?** The test zap has only a trigger
step (no action steps). After the trigger completes, `markCompleted()` is called immediately.
But depending on race conditions, the run might transition through `filtered` if the filter
evaluation runs before the run is marked completed. The test accepts either terminal state.

```typescript
describe('8.4.1 Crash recovery guarantee (backed by integration tests)', () => {
  it('documents the crash recovery semantics', () => {
    // Crash recovery is verified by:
    //  - claim.service.integration.test.ts: simultaneous claim → only 1 wins
    //  - The sequential-executor always resumes from maxCompletedPosition + 1
    //  - SIGKILL mid-step → step stays 'processing' past lease timeout
    //  - reclaim() marks it 'ambiguous' and halts run (does NOT re-execute)
    expect(true).toBe(true);
  });
});
```

**A documentation test.** `expect(true).toBe(true)` always passes. This test exists purely as
documentation — it records the crash recovery guarantees and points to the integration tests that
verify them. Reading this test tells you exactly what the crash recovery system does and where
to find the verification tests.

---

*Continue to: [DD5 — The `app-api` Server, Auth, Middleware & Complete Request Lifecycle](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD5_APP_API_AND_AUTH.md)*

*Or return to the [README index](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/README.md)*
