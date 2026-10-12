# Chapter 6 — Execution Engine & Worker Core (`apps/worker`)

> **ZapFlow Builder's Manual & Architecture Journey**  
> *Chapter 6 of 10*

---

## 6.1 Worker Architecture & Consumer Dynamics

The `worker` service (`apps/worker`) is the workhorse of the ZapFlow engine. It consumes events from Kafka, orchestrates the sequential step pipeline, executes connector adapters, and manages step state transitions.

```
                           Kafka Topic: zap.run.requested
                                         │
                                         ▼
                            ┌────────────────────────┐
                            │ KafkaJS Consumer Group │
                            │ (eachBatch + Heartbeat)│
                            └────────────┬───────────┘
                                         ▼
                            ┌────────────────────────┐
                            │  Claim / Initialize Run│
                            │  (Freeze step_snapshot)│
                            └────────────┬───────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           SEQUENTIAL EXECUTOR LOOP                              │
│                                                                                 │
│   Find next step at position K (resumes from maxCompletedPosition + 1)          │
│                                                                                 │
│   ┌────────────────────┬────────────────────┬───────────────────────────────┐   │
│   │   TRIGGER STEP     │    FILTER STEP     │          ACTION STEP          │   │
│   │                    │                    │                               │   │
│   │ - Already fired    │ - Evaluate boolean │ 1. Redis Rate Check           │   │
│   │ - Alias payload    │   condition        │ 2. Template Substitution      │   │
│   │   to `step_1`      │ - If FALSE: halt   │ 3. Relaxed AJV Validation     │   │
│   │ - Advance to K+1   │   run as `filtered`│ 4. Decrypt Credentials (AES)  │   │
│   │                    │ - If TRUE: continue│ 5. Connector Adapter HTTP Call│   │
│   │                    │                    │ 6. Lazy OAuth Refresh (on 401)│   │
│   │                    │                    │ 7. Record Result in Database  │   │
│   └────────────────────┴────────────────────┴───────────────────────────────┘   │
│                                         │                                       │
│                                         ▼                                       │
│                Merge Output into Context: `step_{K+1}`                          │
│                Advance Position: K = K + 1                                      │
└─────────────────────────────────────────┬───────────────────────────────────────┘
                                          ▼
                      Mark zap_run as 'completed' (or 'failed')
```

---

## 6.2 The Kafka Consumer & Session Timeout Prevention

In `apps/worker/src/consumer/run-consumer.ts`, message processing is built around KafkaJS.

### The Heartbeat Problem: `eachBatch` vs. `eachMessage`

A common issue in Kafka-based Node.js applications is **Consumer Group Rebalancing Storms**.

In Kafka, every consumer in a group must send periodic heartbeats to the broker (default: every 3 seconds). If the broker does not receive a heartbeat within `sessionTimeout` (default: 30 seconds), it assumes the consumer is dead, kicks it out of the group, and triggers an expensive partition rebalance across all other worker nodes.

If we used KafkaJS's standard `eachMessage` handler:
```typescript
// ❌ THE DANGEROUS PATTERN
await consumer.run({
  eachMessage: async ({ message }) => {
    // If Step 1 takes 8s, Step 2 takes 12s, Step 3 takes 15s...
    // Total execution time = 35 seconds!
    // The event loop is busy awaiting HTTP requests!
    // NO HEARTBEATS ARE TRANSMITTED!
    // KAFKA ASSUMES WORKER IS DEAD AND KICKS IT OUT!
    await executeLongZap(message);
  }
});
```

### The Solution: `eachBatch` with Manual Heartbeat Interleaving

```typescript
await c.run({
  autoCommit: false,
  eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
    for (const message of batch.messages) {
      if (shuttingDown) break;
      if (!message.value) {
        resolveOffset(message.offset);
        await heartbeat();
        continue;
      }

      try {
        const event = JSON.parse(message.value.toString()) as ZapRunRequestedEvent;
        await onMessage(event);
      } catch (err) {
        logger.error({ err }, '[worker] Error processing message');
      }

      resolveOffset(message.offset);
      // Explicit heartbeat after every message keeps session alive!
      await heartbeat();
    }
    await commitOffsetsIfNecessary();
  },
});
```

By switching to `eachBatch`:
1. We gain direct programmatic access to `await heartbeat()`.
2. Heartbeats are pulsed after each message execution.
3. Message offsets are resolved individually, ensuring that if a worker crashes on message 4 of a 10-message batch, messages 1 through 3 are not reprocessed upon restart.

---

## 6.3 Immutable Step Snapshots: Defending Against Live Edits

When an event triggers a run, what happens if the user simultaneously edits the Zap in their browser (e.g., changes the Slack channel from `#sales` to `#general`, or reorders steps)?

If the worker queried `zap_steps` live during execution, steps could execute against a hybrid Frankenstein configuration—Step 1 against the old config, and Step 2 against the new config.

### The Snapshot Solution:
When the worker claims the run in `onMessage`:

```sql
UPDATE zap_runs
SET
  status = 'in_progress',
  step_snapshot = (
    SELECT json_agg(
      json_build_object(
        'id', zs.id,
        'position', zs.position,
        'stepType', zs.step_type,
        'availableActionId', zs.available_action_id,
        'availableTriggerId', zs.available_trigger_id,
        'connectionId', zs.connection_id,
        'config', zs.config,
        'availableAction', (
          SELECT json_build_object('inputSchema', aa.input_schema)
          FROM available_actions aa WHERE aa.id = zs.available_action_id
        )
      ) ORDER BY zs.position
    ) FROM zap_steps zs WHERE zs.zap_id = ${zapId}
  )
WHERE webhook_event_id = ${webhookEventId} AND status = 'queued'
RETURNING id, step_snapshot;
```

The worker serializes the entire step chain, schemas, and configurations into `step_snapshot (JSONB)`. The pipeline executes **exclusively against this frozen snapshot**. Modifications in the dashboard apply only to *future* webhooks.

---

## 6.4 The Sequential Execution Engine (`sequential-executor.ts`)

Let us inspect `apps/worker/src/engine/sequential-executor.ts`:

### 6.4.1 Recursion vs. Iteration (Fixing Bug B14)

Early prototypes implemented step execution recursively:
```typescript
// ❌ RECURSIVE PATTERN (BUG B14)
async function resume(zapRun, context, position) {
  await runStep(position);
  return resume(zapRun, context, position + 1); // Stack frame retained!
}
```
In Node.js, V8 does not guarantee Proper Tail Call (PTC) optimization. A Zap with 20 steps holding large JSON payloads retained 20 nested async stack frames, inflating memory and risking stack overflow errors.

### The Iterative Refactor:
```typescript
export async function resume(
  zapRun: ZapRunWithSnapshot,
  payloadContext: Record<string, unknown>,
): Promise<void> {
  const steps = (zapRun.stepSnapshot as SnapshotStep[]) ?? [];

  // 1. Resumption Checkpoint: Find highest completed position
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

  // 2. Iterative execution loop (O(1) memory stack)
  while (true) {
    const nextStep = steps.find((s) => s.position === currentPosition);

    if (!nextStep) {
      // All steps exhausted — transition run to completed!
      await markCompleted(zapRun.id);
      return;
    }

    const stepId = BigInt(nextStep.id);
    const claimed = await claim(zapRun.id, stepId);
    if (!claimed) return; // Actively owned elsewhere or already done

    // ─── STEP DISPATCH BRANCHES (Trigger, Filter, Action) ───
    ...
  }
}
```

### Self-Healing Crash Recovery:
If the worker process is killed by `kill -9` while executing Step 2:
1. When Kafka redelivers the event or a recovery job restarts the run, `completedSteps` discovers that Step 0 and Step 1 are already marked `completed` in PostgreSQL.
2. `maxCompletedPosition` evaluates to `1`.
3. `currentPosition` initializes to $1 + 1 = 2$.
4. **Step 0 and Step 1 are never re-executed.** The pipeline seamlessly resumes directly at Step 2!

---

## 6.5 The 8-Stage Step Runner (`step-runner.ts`)

For an action step, `runStep()` executes an 8-stage sequence:

```typescript
export async function runStep(
  step: ZapStepWithAction,
  payloadContext: Record<string, unknown>,
  idempotencyKey: string,
  claimedRowId: bigint,
): Promise<StepRunResult> {
  // 1. Redis Token Bucket Rate Limit Check
  const underLimit = await checkAndConsume(
    step.connectionId!,
    env.WORKER_RATE_LIMIT_PER_CONNECTION,
    env.WORKER_RATE_LIMIT_WINDOW_SECONDS,
  );
  if (!underLimit) {
    await releaseWithDelay(claimedRowId);
    return { status: 'processing' }; // Backpressure: requeue, do not fail!
  }

  // 2. Template Substitution (e.g. {{step_1.payload.amount}})
  const { mappedPayload, unresolvedFields } = substituteTemplates(
    step.config,
    payloadContext,
  );

  // 3. Relaxed AJV Schema Validation
  const validation = validateMappedPayload(
    mappedPayload,
    step.availableAction?.inputSchema ?? null,
    unresolvedFields,
  );
  if (!validation.success) {
    return { status: 'failed', errorCode: validation.errorCode, errorMessage: validation.errorMessage };
  }

  // 4. Credential Decryption (AES-256-GCM)
  const credentials = await getCredentials(step.connectionId!);

  // 5. Build & Dispatch Request via Connector Adapter
  return executeWithRefresh(step, mappedPayload, credentials, idempotencyKey, unresolvedFields, false);
}
```

---

## 6.6 Template Substitution Engine (`template-substitution.ts`)

Users configure action fields with mustache-style tokens:
`"Amount received: ${{step_1.payload.payment.amount}} from {{step_1.payload.payment.email}}"`

In `apps/worker/src/engine/template-substitution.ts`:

```typescript
function substituteValue(
  template: unknown,
  context: Record<string, unknown>,
): { value: unknown; resolved: boolean } {
  if (typeof template !== 'string') {
    return { value: template, resolved: true };
  }

  // Rule 1: Type Preservation for single tokens
  const singleTokenMatch = template.match(/^\{\{([^}]+)\}\}$/);
  if (singleTokenMatch) {
    const path = singleTokenMatch[1].trim();
    const { value, found } = resolvePath(context, path);
    return { value: found ? value : null, resolved: found };
  }

  // Rule 2: String Interpolation for mixed strings
  let allResolved = true;
  const result = template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const { value, found } = resolvePath(context, path.trim());
    if (!found) {
      allResolved = false;
      return '';
    }
    return String(value);
  });

  return { value: result, resolved: allResolved };
}
```

### The Type Preservation Insight:
If a third-party API requires a number (e.g. `amount: 5000`), and the user configures the field as `{{step_1.payload.amount}}`:
- Naive regex string interpolation turns this into the string `"5000"`.
- The third-party API rejects it with `Validation Error: amount must be a number`.
- `singleTokenMatch` detects that the entire input is a single token and returns the raw `value: 5000` (preserving its JavaScript `number` type)!

### Unresolved Tokens Resolve to `null` (Not Strings):
If a token cannot be resolved (e.g., an optional middle name field), it evaluates to `null`, **not a string like `"[missing]"` or `"undefined"`**. This allows downstream JSON schema validators to gracefully accept missing optional fields.

---

## 6.7 Schema Validation Relaxation (`payload-validator.ts`)

When third-party connectors define their `inputSchema`, certain fields might be declared as `required` or strictly typed as `string`. However, in real-world workflows, a trigger might omit an optional property.

If AJV strictly validated the payload, a missing optional field would abort the entire Zap with `VALIDATION_FAILED`.

In `apps/worker/src/engine/payload-validator.ts`:

```typescript
function relaxRequiredAndTypesFor(
  inputSchema: AnySchema,
  unresolvedFields: string[],
): AnySchema {
  const schema = JSON.parse(JSON.stringify(inputSchema));
  if (unresolvedFields.length === 0) return schema;

  // 1. Remove unresolved fields from the required array
  if (Array.isArray(schema['required'])) {
    schema['required'] = schema['required'].filter(
      (field) => !unresolvedFields.includes(field),
    );
  }

  // 2. Allow null type for unresolved fields
  const properties = schema['properties'];
  if (properties) {
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
  }

  return schema;
}
```

The validator dynamically relaxes the schema rules *only for fields that were legitimately unresolved in the template mapping*, striking the perfect balance between strict type safety and workflow resilience.

---

## 6.8 Network Error Classification & Lazy OAuth Refresh

When an outbound HTTP call to Slack or GitHub fails, how does the engine react?

In `step-runner.ts` (`executeWithRefresh`):

```typescript
try {
  const response = await axios({ ...request, timeout: 30000 });
  return adapter.parseResponse(response.data);
} catch (err) {
  const axiosErr = err as AxiosError;

  // Case 1: OAuth 401 Unauthorized -> Lazy Refresh Flow
  if (axiosErr.response?.status === 401 && !isRetry) {
    if (credentials.type === 'oauth') {
      await refreshToken(step.connectionId!);
      const newCredentials = await getCredentials(step.connectionId!);
      return executeWithRefresh(step, mappedPayload, newCredentials, idempotencyKey, unresolvedFields, true);
    }
    return {
      status: 'failed',
      errorCode: 'INVALID_API_KEY',
      errorMessage: 'Stored API key was rejected. Reconnect this app.',
    };
  }

  // Case 2: Ambiguous Network Failures
  if (isAmbiguousNetworkError(axiosErr.code) || (axiosErr.response?.status ?? 0) >= 500) {
    return {
      status: 'ambiguous',
      errorCode: 'AMBIGUOUS_TIMEOUT',
      errorMessage: 'Request timed out or server errored with no confirmation. Outcome unknown.',
    };
  }

  // Case 3: Standard Client Error (4xx)
  return {
    status: 'failed',
    errorCode: 'REQUEST_ERROR',
    errorMessage: axiosErr.message,
  };
}
```

### The Lazy Refresh Pattern:
Instead of running a heavy cron job every 60 seconds querying all OAuth tokens in the database, ZapFlow treats `HTTP 401 Unauthorized` as a lazy cache invalidation signal:
1. The remote API returns 401. Because it was rejected before execution, no side-effect occurred.
2. The worker calls the connector's OAuth token endpoint using the stored refresh token.
3. The new access token is encrypted and written to the database.
4. The worker retries the action once (`isRetry = true`).

### The Ambiguous Outcome Principle:
If Axios throws `ECONNABORTED` (timeout after 30 seconds), did Slack receive the request and post the message before our connection dropped, or did it fail before receiving it?  
**We cannot know.** Retrying blindly could post a duplicate message or charge a credit card twice.  
The engine classifies this as `'ambiguous'`, halts the run, and flags it for operator review.

In Chapter 7, we explore distributed leases, concurrency control, and resilience jobs.
