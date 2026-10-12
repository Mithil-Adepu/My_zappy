# Deep Dive 9 — The Zap Controller: Every Endpoint, Line by Line

> This chapter dissects `zap.controller.ts` — the largest single controller in the codebase —
> explaining every CRUD operation in full detail: the atomic create-with-steps transaction,
> the `$executeRawUnsafe` multi-row resequencing after deleteStep, the `PrismaTx` type
> trick, the addStep validation strategy, the updateStep config diff semantics, and the security
> engineering behind webhook secret isolation.

---

## Table of Contents

1. [The `PrismaTx` Type — Extracting the Transaction Client Type](#1-the-prismaprimatx-type--extracting-the-transaction-client-type)
2. [Zod Schemas — Input Validation for Zaps and Steps](#2-zod-schemas--input-validation-for-zaps-and-steps)
3. [`listZaps` — `_count` Aggregate in a Single Query](#3-listzaps--_count-aggregate-in-a-single-query)
4. [`getZap` — Explicit Select to Exclude `webhookSecret`](#4-getzap--explicit-select-to-exclude-webhooksecret)
5. [`createZap` — Atomic Create-with-Steps, Validation Order](#5-createzap--atomic-create-with-steps-validation-order)
6. [`updateZap` — Ownership-then-Update Pattern](#6-updatezap--ownership-then-update-pattern)
7. [`deleteZap` — CASCADE Handles Everything](#7-deletezap--cascade-handles-everything)
8. [`addStep` — Validate the Full Step Set After Adding](#8-addstep--validate-the-full-step-set-after-adding)
9. [`updateStep` — Step-Level IDOR Prevention](#9-updatestep--step-level-idor-prevention)
10. [`deleteStep` — The `$executeRawUnsafe` Resequencer](#10-deletestep--the-executerawunsafe-resequencer)
11. [`getWebhookSecret` — The Isolated Secret Endpoint](#11-getwebhooksecret--the-isolated-secret-endpoint)
12. [The Full CRUD Surface Area — One Reference Table](#12-the-full-crud-surface-area--one-reference-table)

---

## 1. The `PrismaTx` Type — Extracting the Transaction Client Type

**Lines 12:** `apps/app-api/src/controllers/zap.controller.ts`

```typescript
/** Type of the interactive client inside a prisma.$transaction callback. */
type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
```

This is one of the most sophisticated TypeScript type expressions in the codebase. Let's unpack
it inside-out:

**`typeof prisma.$transaction`** — gets the TypeScript type of the `$transaction` method on the
prisma client.

**`Parameters<...>[0]`** (outer) — gets the first parameter of `$transaction`. The `$transaction`
method signature is:
```typescript
$transaction<R>(fn: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R>
```
The first parameter is `fn: (tx: Prisma.TransactionClient) => Promise<R>`.

**`Parameters<...>[0]`** (inner) — gets the first parameter of `fn`, which is the `tx` argument.
This is `Prisma.TransactionClient`.

**Result: `type PrismaTx = Prisma.TransactionClient`.**

**Why not just write `Prisma.TransactionClient` directly?**
```typescript
// This would also work:
import { Prisma } from '@zapier-clone/db';
type PrismaTx = Prisma.TransactionClient;
```

The indirect `Parameters<...>` approach avoids importing `Prisma` separately. It extracts the
type from the already-imported `prisma` instance. This is a "don't add a new import if you can
extract from existing ones" philosophy.

**Why do we need this type at all?**
```typescript
await prisma.$transaction(async (tx: PrismaTx) => {
  await tx.zapStep.delete({ where: { id: stepId } });
  await tx.$executeRawUnsafe(`UPDATE zap_steps ...`);
});
```

Inside the transaction callback, `tx` is NOT the same type as `prisma`. It's a transaction-bound
client that can't start nested transactions. TypeScript needs the explicit `PrismaTx` annotation
so `tx.zapStep.delete()` and `tx.$executeRawUnsafe()` are correctly typed.

---

## 2. Zod Schemas — Input Validation for Zaps and Steps

```typescript
const stepSchema = z.object({
  stepType:            z.enum(['trigger', 'action', 'filter']),
  position:            z.number().int().min(0),
  availableTriggerId:  z.string().optional().nullable(),
  availableActionId:   z.string().optional().nullable(),
  connectionId:        z.string().optional().nullable(),
  config:              z.record(z.unknown()).default({}),
});

const createZapSchema = z.object({
  name:            z.string().min(1).max(200),
  isActive:        z.boolean().default(true),
  maxRunsPerHour:  z.number().int().min(1).max(10000).default(100),
  steps:           z.array(stepSchema).min(1),
});
```

### `connectionId: z.string().optional().nullable()`

`connectionId` comes from the frontend as a string ID (because the frontend serializes IDs as
strings — bigints can't be passed as JSON numbers). It's `optional` (not required in the request)
and `nullable` (can explicitly be `null` to "clear" a connection). This three-state value:
- Not present → `undefined` → connection unchanged (in update operations)
- `null` → connection cleared
- `"42"` → set connection to ID 42

**In the body mapping:** `connectionId: step.connectionId ? BigInt(step.connectionId) : null`.
This converts the string `"42"` → `BigInt(42n)` or leaves it as `null` if not set.

### `config: z.record(z.unknown()).default({})`

`z.record(z.unknown())` — accepts any JSON object (any string keys, any values). The `config`
field stores template mappings like:
```json
{ "channel": "#general", "text": "{{step_0.payload.body.text}}" }
```

The exact shape depends on the connector's `inputSchema`. We validate only that `config` is an
object (not a string, number, or array). The worker validates specific fields against `inputSchema`
using AJV (DD3 §9).

**`.default({})`** — if `config` is omitted from the request, Zod fills it with `{}`. The DB
column also defaults to `'{}'::jsonb`. Both layers agree on the default, preventing null config
from causing issues.

### `maxRunsPerHour: z.number().int().min(1).max(10000).default(100)`

This is the per-hour run cap enforced by Redis rate limiting (DD3 §12). Limits:
- `min(1)` — at least 1 run per hour (0 would make the zap permanently blocked)
- `max(10000)` — prevents a user from setting an absurdly high cap to bypass rate limiting
- `default(100)` — matches the DB column default

---

## 3. `listZaps` — `_count` Aggregate in a Single Query

```typescript
export async function listZaps(req, res, next): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zaps = await prisma.zap.findMany({
      where: { userId },
      include: { _count: { select: { steps: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(zaps.map(serializeBigInt));
  } catch (err) {
    next(err);
  }
}
```

### `include: { _count: { select: { steps: true } } }`

**`_count`** is Prisma's relation count syntax. Without it, getting the step count for 20 zaps
would require either:
1. Including all steps (loading 0-50 step objects per zap → potentially hundreds of rows)
2. Running a separate `prisma.zapStep.count({ where: { zapId } })` query per zap (N+1 problem)

`_count` translates to a SQL COUNT in the same query:
```sql
SELECT z.*, COUNT(s.id) AS steps_count
FROM zaps z
LEFT JOIN zap_steps s ON z.id = s.zap_id
WHERE z.user_id = $1
GROUP BY z.id
ORDER BY z.created_at DESC
```

The result includes `_count: { steps: 5 }` directly on the zap object — no extra queries.

**Why show step count in the list view?** The frontend displays it as "5 steps" next to each
zap's name, giving users a quick sense of zap complexity without loading the full step set.

### `zaps.map(serializeBigInt)`

Each zap object has `id: bigint`, `userId: bigint`. After `serializeBigInt`, these become
`id: "42"`, `userId: "99"`. The `_count` field (`{ steps: 5 }`) is a plain number — `serializeBigInt`
passes it through unchanged (not a bigint).

### Why `orderBy: { createdAt: 'desc' }` (newest first)?

Newest zaps appear first — the most recently created automation is likely what the user is
actively working on. This matches how most SaaS dashboards order lists (Gmail, Notion, etc.).

---

## 4. `getZap` — Explicit Select to Exclude `webhookSecret`

```typescript
const zap = await prisma.zap.findFirst({
  where: { id: zapId, userId },
  include: {
    steps: {
      orderBy: { position: 'asc' },
      select: {
        id: true, zapId: true, stepType: true, position: true,
        availableTriggerId: true, availableActionId: true,
        connectionId: true, config: true, createdAt: true,
        availableTrigger: true, availableAction: true,
        // webhookSecret intentionally NOT listed here
      },
    },
  },
});
```

### The `select` on a nested `include`

You can nest `select` inside an `include` to filter the fields of a related model. Without
`select`, Prisma returns ALL fields of `ZapStep` — including `webhookSecret`. By explicitly
listing all fields EXCEPT `webhookSecret`, we ensure it never appears in the response.

**Why not use `omit: { webhookSecret: true }`?** Prisma does support `omit` in newer versions,
but the explicit `select` approach is more defensive — it requires adding new fields explicitly.
With `omit`, a new column added to `ZapStep` would appear in the response by default. With
`select`, a new column is hidden until explicitly added.

### `findFirst` vs `findUnique` for ownership check

```typescript
prisma.zap.findFirst({ where: { id: zapId, userId } })
```

**Why `findFirst` with both `id` AND `userId` instead of `findUnique` with just `id`?**

`findUnique` is limited to unique key lookups. We could do:
```typescript
const zap = await prisma.zap.findUnique({ where: { id: zapId } });
if (!zap || zap.userId !== userId) throw createError('Zap not found', 404);
```

But this is a TOCTOU (Time-Of-Check-Time-Of-Use) vulnerability: between `findUnique` and the
ownership check, another request could modify the zap. More importantly, returning 403 vs 404
leaks information: "403 means the zap exists but you don't own it, 404 means it doesn't exist."

`findFirst({ id: zapId, userId })` returns `null` for BOTH "zap doesn't exist" and "zap exists
but wrong owner." The caller gets the same 404 in both cases. No information leakage.

---

## 5. `createZap` — Atomic Create-with-Steps, Validation Order

```typescript
export async function createZap(req, res, next): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const body = createZapSchema.parse(req.body);

    validateZapSteps(body.steps);              // 1. Structural validation

    for (const step of body.steps) {          // 2. Ownership validation
      if (step.connectionId) {
        await assertConnectionOwnership(BigInt(step.connectionId), userId);
      }
    }

    const zap = await prisma.zap.create({    // 3. DB write (atomic)
      data: {
        userId, name: body.name, isActive: body.isActive,
        maxRunsPerHour: body.maxRunsPerHour,
        steps: {
          create: body.steps.map((step) => ({
            ...step,
            connectionId: step.connectionId ? BigInt(step.connectionId) : null,
            webhookSecret: step.stepType === 'trigger'
              ? crypto.randomBytes(32).toString('hex')
              : null,
          })),
        },
      },
      include: { steps: { orderBy: { position: 'asc' }, select: { ... } } },
    });

    res.status(201).json(serializeBigInt(zap));
  } catch (err) {
    next(err);
  }
}
```

### Validation order: schema → structural → ownership → DB

The three validation stages run in order of cheapness:

1. **Zod schema parse** — purely in-memory, no I/O. Rejects malformed inputs immediately.
2. **`validateZapSteps`** — purely in-memory (no DB queries). Checks contiguity, trigger rules.
3. **`assertConnectionOwnership`** — one DB query per step with a `connectionId`. Runs AFTER
   structural validation so we don't waste DB queries on structurally invalid input.
4. **`prisma.zap.create`** — the actual DB write, only after all validations pass.

**Why not run ownership checks inside the Prisma transaction?** Ownership checks are reads, not
writes. Running them outside the transaction is fine — the connection ownership can't change
between the ownership check and the create in any way that would matter (a user can't lose
ownership of their own connection in milliseconds).

### `prisma.zap.create` with nested `steps.create`

```typescript
prisma.zap.create({
  data: {
    userId,
    steps: {
      create: body.steps.map((step) => ({ ... }))
    }
  }
})
```

This is Prisma's **nested write** — it creates the `Zap` row AND all `ZapStep` rows in a single
database transaction. If any step creation fails (e.g., a `connectionId` FK violation), Prisma
rolls back the entire transaction — no partially-created zap.

**Without nested write:**
```typescript
const zap = await prisma.zap.create({ data: { userId, name } });
for (const step of steps) {
  await prisma.zapStep.create({ data: { zapId: zap.id, ...step } });
}
// If step 3 fails, steps 1 and 2 exist but step 3 doesn't — corrupted state!
```

Nested writes eliminate this risk.

### `crypto.randomBytes(32).toString('hex')` — the webhook secret

Each trigger step gets a fresh random 32-byte (256-bit) webhook secret at creation time:
```typescript
webhookSecret: step.stepType === 'trigger'
  ? crypto.randomBytes(32).toString('hex')
  : null,
```

**`crypto.randomBytes(32)`** — 32 bytes from the operating system's CSPRNG (Cryptographically
Secure Pseudo-Random Number Generator). On Linux/Docker, reads from `/dev/urandom`. Unforgeable
and unpredictable.

**`.toString('hex')`** — produces a 64-character hex string (`a3b4c5...`). This is what webhook
providers use as the HMAC key for signing their webhook payloads (DD1 §6).

**Why 32 bytes?** 32 bytes = 256 bits of entropy. The same entropy level as a 256-bit AES key.
An attacker brute-forcing a 256-bit secret would need 2^128 attempts on average — physically
impossible with any current or foreseeable hardware.

**Why not include `webhookSecret` in the response?** It's already excluded via the `select`
block in the `include`. The creation response shows the step fields the frontend needs for
configuration. The secret is fetched separately via `GET /zaps/:id/steps/:stepId/webhook-secret`
only when the user needs to configure their webhook provider.

---

## 6. `updateZap` — Ownership-then-Update Pattern

```typescript
export async function updateZap(req, res, next): Promise<void> {
  const { userId } = req as AuthenticatedRequest;
  const zapId = BigInt(req.params.id);

  const body = z.object({
    name:           z.string().min(1).max(200).optional(),
    isActive:       z.boolean().optional(),
    maxRunsPerHour: z.number().int().min(1).max(10000).optional(),
  }).parse(req.body);

  const existing = await prisma.zap.findFirst({ where: { id: zapId, userId } });
  if (!existing) throw createError('Zap not found', 404);

  const zap = await prisma.zap.update({
    where: { id: zapId },
    data: body,
  });

  res.json(serializeBigInt(zap));
}
```

### Why `findFirst` then `update` instead of `update` directly?

Prisma's `update` requires a unique key in `where`. `findFirst` can filter by non-unique fields.
The pattern:
```typescript
// Attempt: cannot filter by userId in update.where (only unique fields allowed)
await prisma.zap.update({ where: { id: zapId, userId }, data: body });
// This would cause a TypeScript error — userId is not a unique key
```

So we must do it in two steps:
1. `findFirst({ id: zapId, userId })` — ownership check (returns null if wrong user)
2. `update({ id: zapId })` — the actual update

**Race condition concern:** Between step 1 and step 2, another user could (theoretically)
become the zap owner. In practice this is impossible — zap ownership never changes after creation.
`userId` on a zap is set at creation and never updated.

### `data: body` — Prisma's partial update semantics

`body` from Zod is `{ name?: string, isActive?: boolean, maxRunsPerHour?: number }` — all
fields optional. Zod's `.optional()` means the field might not be in the request. If not present,
it's `undefined`.

**Prisma's `update` ignores `undefined` fields.** So if the request is `{ isActive: false }`,
`body = { isActive: false }`. Prisma generates:
```sql
UPDATE zaps SET is_active = false WHERE id = $1
```

Not updating `name` or `max_runs_per_hour`. This is the "partial update" (PATCH semantics).
Contrast with "full update" (PUT semantics) where ALL fields must be provided.

---

## 7. `deleteZap` — CASCADE Handles Everything

```typescript
export async function deleteZap(req, res, next): Promise<void> {
  const { userId } = req as AuthenticatedRequest;
  const zapId = BigInt(req.params.id);

  const existing = await prisma.zap.findFirst({ where: { id: zapId, userId } });
  if (!existing) throw createError('Zap not found', 404);

  await prisma.zap.delete({ where: { id: zapId } });
  res.status(204).send();
}
```

### `res.status(204).send()` — the 204 response

**204 No Content** — the standard HTTP response for successful DELETE. No response body.
The resource is gone; there's nothing to return.

**Why not 200?** A 200 response typically includes a response body. For DELETE, there's nothing
to return. 204 explicitly signals "success, no content" without forcing a JSON body.

### Cascade deletion via FK

Deleting the zap triggers FK cascade deletions:
```
zap deleted
  → zap_steps (ON DELETE CASCADE)
      → zap_run_steps (ON DELETE CASCADE via zap_step)
  → webhook_events (ON DELETE CASCADE)
      → outbox (ON DELETE CASCADE via webhook_event)
  → zap_runs (ON DELETE CASCADE)
      → zap_run_steps (ON DELETE CASCADE via zap_run)
```

ALL related data is deleted in the DB by PostgreSQL automatically. The application code never
needs to manually delete steps, runs, or events — CASCADE handles it.

**Why Prisma doesn't need explicit `cascade: true`:** The cascade is defined in the schema
(`@relation(onDelete: Cascade)`), which translates to `ON DELETE CASCADE` in SQL. PostgreSQL
enforces it — Prisma just tells Postgres to delete the zap row.

---

## 8. `addStep` — Validate the Full Step Set After Adding

```typescript
export async function addStep(req, res, next): Promise<void> {
  const { userId } = req as AuthenticatedRequest;
  const zapId = BigInt(req.params.id);

  // Load the zap AND its current steps
  const existing = await prisma.zap.findFirst({
    where: { id: zapId, userId },
    include: { steps: true },  // ← needed for validation
  });
  if (!existing) throw createError('Zap not found', 404);

  const body = stepSchema.parse(req.body);

  if (body.connectionId) {
    await assertConnectionOwnership(BigInt(body.connectionId), userId);
  }

  // Validate: existing steps + new step must form a valid set
  const newStepSet = [
    ...existing.steps,
    { ...body, connectionId: body.connectionId ?? null },
  ];
  validateZapSteps(newStepSet);

  const step = await prisma.zapStep.create({ ... });
  res.status(201).json(serializeBigInt(step));
}
```

### Why include existing steps and validate the full set?

When adding a step, we can't validate just the new step in isolation — we need to check the
invariants of the ENTIRE step set after adding.

**Example violations caught by full-set validation:**

1. **Adding a second trigger:**
   - Existing steps: `[{position: 0, stepType: 'trigger'}]`
   - New step: `{position: 1, stepType: 'trigger'}`
   - After merge: two triggers → `validateZapSteps` throws "A zap must have exactly one trigger step"

2. **Creating a position gap:**
   - Existing steps: `[{position: 0}, {position: 1}]`
   - New step: `{position: 5}`
   - After merge: sorted positions `[0, 1, 5]` → sorted[2] = 5 ≠ 2 → throws gap error

3. **Duplicate position:**
   - Existing steps: `[{position: 0}, {position: 1}]`
   - New step: `{position: 1}`
   - After merge: two steps at position 1 → throws duplicate error

Without full-set validation, these errors would only be caught when the worker tries to execute
the zap — a much worse time to discover configuration errors.

### `include: { steps: true }` — loading all current steps

The extra `include: { steps: true }` in `findFirst` loads all existing step data (including
`stepType`, `position`, `availableTriggerId`, `connectionId`). This is the data `validateZapSteps`
needs. It's a second query vs `getZap` (which omits `steps`), but the extra ~5ms is worth the
validation correctness.

---

## 9. `updateStep` — Step-Level IDOR Prevention

```typescript
export async function updateStep(req, res, next): Promise<void> {
  const { userId } = req as AuthenticatedRequest;
  const zapId  = BigInt(req.params.id);
  const stepId = BigInt(req.params.stepId);

  const zap = await prisma.zap.findFirst({ where: { id: zapId, userId } });
  if (!zap) throw createError('Zap not found', 404);

  // IDOR prevention: verify the step belongs to THIS zap
  const existingStep = await prisma.zapStep.findFirst({
    where: { id: stepId, zapId },
  });
  if (!existingStep) throw createError('Step not found', 404);

  const body = z.object({
    config:       z.record(z.unknown()).optional(),
    connectionId: z.string().nullable().optional(),
  }).parse(req.body);

  if (body.connectionId) {
    await assertConnectionOwnership(BigInt(body.connectionId), userId);
  }

  const step = await prisma.zapStep.update({
    where: { id: stepId },
    data: {
      ...(body.config && { config: body.config as object }),
      ...(body.connectionId !== undefined && {
        connectionId: body.connectionId ? BigInt(body.connectionId) : null,
      }),
    },
  });

  res.json(serializeBigInt(step));
}
```

### Two-level IDOR check

**Level 1:** `prisma.zap.findFirst({ id: zapId, userId })` — verifies the user owns the zap.

**Level 2:** `prisma.zapStep.findFirst({ id: stepId, zapId })` — verifies the step belongs to
the zap.

**Why two levels?** Consider this attack:
```
User A: owns Zap #10 with Step #20
User B: owns Zap #99

User B sends: PATCH /zaps/99/steps/20
```

Without Level 2:
1. `findFirst({ id: 99, userId: B's userId })` → finds Zap #99 (User B owns it) ✅
2. `zapStep.update({ id: 20 })` → updates Step #20! (which belongs to User A's Zap #10) ❌

With Level 2:
1. `findFirst({ id: 99, userId: B's userId })` → finds Zap #99 ✅
2. `zapStep.findFirst({ id: 20, zapId: 99 })` → null (Step #20 belongs to zapId=10, not 99) ❌
3. Throws "Step not found" 404 — attack blocked ✅

This is the **path parameter consistency check** — ensuring that nested resource IDs belong to
their parent resources.

### `body.connectionId !== undefined` — three-state semantics

```typescript
...(body.connectionId !== undefined && {
  connectionId: body.connectionId ? BigInt(body.connectionId) : null,
}),
```

`connectionId` is `z.string().nullable().optional()`:
- **Not in request** → `undefined` → don't update connectionId
- **Null in request** → `null` → clear the connection
- **`"42"` in request** → `BigInt("42")` → set to connection 42

The `!== undefined` guard means: only include `connectionId` in the Prisma update if the field
was explicitly present in the request. This allows PATCH semantics — sending `{ config: {...} }`
without `connectionId` leaves the existing connection unchanged.

---

## 10. `deleteStep` — The `$executeRawUnsafe` Resequencer

```typescript
export async function deleteStep(req, res, next): Promise<void> {
  const { userId } = req as AuthenticatedRequest;
  const zapId  = BigInt(req.params.id);
  const stepId = BigInt(req.params.stepId);

  const zap = await prisma.zap.findFirst({
    where: { id: zapId, userId },
    include: { steps: true },
  });
  if (!zap) throw createError('Zap not found', 404);

  const stepToDelete = zap.steps.find((s) => s.id === stepId);
  if (!stepToDelete) throw createError('Step not found', 404);

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

  res.status(204).send();
}
```

### The resequencing problem

When we delete a step, the remaining steps have a gap in positions:
```
Before delete: [0=trigger, 1=action, 2=filter, 3=action]
Delete position 1:
After delete:  [0=trigger, 2=filter, 3=action]  ← gap at 1!
```

The sequential executor (`currentPosition++`) would skip position 1, find position 2 at its
first increment, and work correctly by accident... but only if positions are NOT used as
indices in array lookups. However, `validateZapSteps` would reject this as a gap. We must
resequence to maintain contiguity.

Expected result:
```
After resequence: [0=trigger, 1=filter, 2=action]  ← contiguous
```

### Why `$executeRawUnsafe` and not N individual `prisma.zapStep.update` calls?

The naive approach:
```typescript
for (let i = 0; i < remaining.length; i++) {
  await tx.zapStep.update({
    where: { id: remaining[i].id },
    data: { position: i },
  });
}
```

**Problem:** N separate UPDATE statements = N DB round-trips within the transaction. With 20
steps, that's 20 sequential DB calls, each incurring network latency (even if the DB is local,
each call has CPU overhead). For a `deleteStep` operation, users expect fast response.

**The `$executeRawUnsafe` solution — one UPDATE statement:**
```sql
UPDATE zap_steps AS t
SET position = v.new_pos
FROM (VALUES (5::bigint, 0), (7::bigint, 1), (9::bigint, 2)) AS v(id, new_pos)
WHERE t.id = v.id AND t.position != v.new_pos
```

This is a **VALUES list UPDATE** (PostgreSQL-specific syntax). The `FROM (VALUES ...)` clause
creates an inline table `v(id, new_pos)`. The `JOIN` on `t.id = v.id` updates only the matching
rows. `t.position != v.new_pos` skips rows where the position is already correct (micro-optimization
that avoids unnecessary writes).

**One round-trip, all rows updated simultaneously.** No N+1 problem.

### Why `$executeRawUnsafe` and not `$executeRaw`?

`$executeRaw` is for queries with static SQL and Prisma placeholders (`$1`, `$2`). Our VALUES
list is dynamically constructed (number of rows varies). Prisma's tagged template (`$executeRaw`
with template literals) can't handle a variable number of SQL VALUES clauses.

`$executeRawUnsafe` accepts a plain string — allowing dynamic SQL generation. The `Unsafe` suffix
warns you that you're responsible for SQL injection prevention. **Is our code safe?**

```typescript
const values = remaining
  .map((s, i) => `(${s.id}::bigint, ${i})`)
  .join(', ');
```

`s.id` is a BigInt (from Prisma) — it cannot contain arbitrary SQL characters. BigInts are always
integers. `i` is a loop counter integer. Neither can contain SQL injection. The `::bigint` cast
tells PostgreSQL to treat the value as a BIGINT, preventing type confusion.

**If `s.id` were a string (from user input), this would be dangerous.** But `s.id` comes from
`zap.steps` which was loaded from the DB — it's always a DB-native bigint.

### The transaction — why both operations must be atomic

```typescript
await prisma.$transaction(async (tx) => {
  await tx.zapStep.delete({ where: { id: stepId } });
  await tx.$executeRawUnsafe(`UPDATE zap_steps ...`);
});
```

**What if we didn't use a transaction?**

```
1. DELETE step (position 1) — committed immediately
   Now: [0, 2, 3] — gap exists! Sequential executor would fail.

2. Server crashes before UPDATE runs
   DB is left with positions [0, 2, 3] forever — broken state.
```

The transaction ensures both the DELETE and the resequencing UPDATE are atomic — either both
succeed, or neither does. If the server crashes between the two statements, the transaction
is rolled back and the step is NOT deleted — the zap is intact.

---

## 11. `getWebhookSecret` — The Isolated Secret Endpoint

```typescript
export async function getWebhookSecret(req, res, next): Promise<void> {
  const { userId } = req as AuthenticatedRequest;
  const zapId  = BigInt(req.params.id);
  const stepId = BigInt(req.params.stepId);

  // Verify zap ownership
  const zap = await prisma.zap.findFirst({ where: { id: zapId, userId } });
  if (!zap) throw createError('Zap not found', 404);

  const step = await prisma.zapStep.findFirst({
    where: { id: stepId, zapId },
    select: { webhookSecret: true, stepType: true },
  });
  if (!step) throw createError('Step not found', 404);
  if (step.stepType !== 'trigger') throw createError('Only trigger steps have a webhook secret', 400);
  if (!step.webhookSecret) throw createError('No webhook secret set for this step', 404);

  res.json({ webhookSecret: step.webhookSecret });
}
```

### The security design of the isolated secret endpoint

**Why a separate endpoint and not include `webhookSecret` in `GET /zaps/:id`?**

The `GET /zaps/:id` response is used in many places:
- Rendering the zap configuration page
- Listing zaps in the dashboard sidebar
- Background polling to detect changes
- Logging/debugging API responses

If `webhookSecret` were in the standard `GET /zaps/:id` response, it would appear in:
- Browser localStorage (if the frontend caches API responses)
- Network logs and debugging tools (Chrome DevTools)
- Backend access logs (if bodies are logged)
- Any analytics tool that intercepts API traffic

By isolating the secret to `GET /zaps/:id/steps/:stepId/webhook-secret`:
- It's only fetched when the user explicitly navigates to the "Setup Webhook" screen
- It's never in ambient API responses that get cached or logged
- The audit trail for "who fetched the webhook secret" is explicit

**Triple ownership check:**
1. `zap.findFirst({ id: zapId, userId })` — user owns the zap
2. `zapStep.findFirst({ id: stepId, zapId })` — step belongs to the zap
3. `step.stepType !== 'trigger'` — only trigger steps have secrets

All three must pass before the secret is returned.

---

## 12. The Full CRUD Surface Area — One Reference Table

| Method | Path | Handler | Auth | What It Does |
|--------|------|---------|------|--------------|
| GET | `/zaps` | `listZaps` | ✅ | All user's zaps with step count |
| POST | `/zaps` | `createZap` | ✅ | Atomic create + steps + secrets |
| GET | `/zaps/:id` | `getZap` | ✅ | Full zap with steps (no secret) |
| PATCH | `/zaps/:id` | `updateZap` | ✅ | Partial update (name/active/cap) |
| DELETE | `/zaps/:id` | `deleteZap` | ✅ | Delete + all children (cascade) |
| POST | `/zaps/:id/steps` | `addStep` | ✅ | Add step, validate full set |
| PATCH | `/zaps/:id/steps/:stepId` | `updateStep` | ✅ | Update config/connection |
| DELETE | `/zaps/:id/steps/:stepId` | `deleteStep` | ✅ | Delete + resequence positions |
| GET | `/zaps/:id/steps/:stepId/webhook-secret` | `getWebhookSecret` | ✅ | Return secret only |

**Every write handler** runs in this order:
1. Extract `userId` from `AuthenticatedRequest`
2. Parse `BigInt(req.params.id)` for path IDs
3. Zod `parse(req.body)` for body
4. `findFirst({ id, userId })` ownership check → 404 if not found
5. Additional IDOR checks (step belongs to zap)
6. Connection ownership checks (`assertConnectionOwnership`)
7. Step set validation (`validateZapSteps`)
8. DB write
9. `serializeBigInt(result)` → `res.json(...)`

This consistent pattern across all handlers makes the security model explicit and auditable.

---

*Continue to: [DD10 — Seed Data & Connector Catalog: Every Entry Explained](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD10_SEED_DATA_AND_CATALOG.md)*
