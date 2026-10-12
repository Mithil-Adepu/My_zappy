# Chapter 8 — Management API, Auth & Frontend Integration

> **ZapFlow Builder's Manual & Architecture Journey**  
> *Chapter 8 of 10*

---

## 8.1 The Management Surface (`apps/app-api`)

The `app-api` service (running on **Port 3001**) serves as the administrative backbone of ZapFlow. Unlike `hooks-api`, which accepts unauthenticated public webhooks, `app-api` is a secured REST API that powers user management, workflow creation, credential storage, and execution history queries.

```
                      Browser (Next.js :3000)
                                 │
                     HTTP Requests with JWT Bearer
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │  app-api Server (:3001)│
                     └───────────┬───────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       ▼                         ▼                         ▼
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ /auth        │          │ /zaps        │          │ /runs        │
│ - Signup     │          │ - CRUD Zaps  │          │ - History    │
│ - Login      │          │ - Steps      │          │ - Step Logs  │
│ - JWT tokens │          │ - Secrets    │          │ - Timelines  │
└──────────────┘          └──────────────┘          └──────────────┘
```

---

## 8.2 The JavaScript BigInt Serialization Dilemma

PostgreSQL uses 64-bit integers (`BIGSERIAL` / `BIGINT`) for primary keys and foreign keys across all ZapFlow tables. When Prisma queries PostgreSQL, it deserializes these columns into native JavaScript `BigInt` primitives (`123456789n`).

However, the ECMAScript standard explicitly forbids `JSON.stringify` from serializing `BigInt`:

```javascript
JSON.stringify({ id: 123456789n });
// ❌ Uncaught TypeError: Do not know how to serialize a BigInt
```

If an Express route passes a Prisma record containing a `BigInt` directly into `res.json(data)`, Node.js crashes with an uncaught `TypeError`!

### The Solution: `apps/app-api/src/lib/serialize.ts`

```typescript
export function serializeBigInt(obj: unknown): any {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}
```

By providing a replacer function to `JSON.stringify`:
1. Every `BigInt` is automatically transformed into a standard JSON string: `123456789n` $\to$ `"123456789"`.
2. Safe 64-bit precision is preserved across the wire (JavaScript numbers lose precision above $2^{53} - 1$).
3. The frontend receives clean JSON without crashing Express.

---

## 8.3 Authentication & JWT Token Issuance

Authentication is implemented in `apps/app-api/src/controllers/auth.controller.ts` and `apps/app-api/src/middleware/auth.middleware.ts`.

### Token Issuance:
```typescript
function issueToken(userId: bigint, name: string): string {
  return jwt.sign({ sub: userId.toString(), name }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN, // 7 days
  });
}
```
- **Subject (`sub`):** Stores the user's primary key serialized as a string.
- **Stateless Verification:** Verification occurs in `authMiddleware` by decoding the `Authorization: Bearer <token>` header against `JWT_SECRET`. No Redis lookup or database roundtrip is required for read authorization.

---

## 8.4 Zap Step Validation & Contiguity Enforcement

A workflow cannot have missing positions, duplicate positions, or an action step positioned before the trigger.

In `apps/app-api/src/services/zap-validation.service.ts`:

```typescript
export function validateZapSteps(steps: StepInput[]): void {
  if (!steps || steps.length === 0) {
    throw createError('A zap must have at least one step (the trigger)', 400);
  }

  // 1. Check for duplicate positions
  const positions = steps.map((s) => s.position);
  const uniquePositions = new Set(positions);
  if (uniquePositions.size !== positions.length) {
    throw createError('Duplicate step positions are not allowed', 400);
  }

  // 2. Enforce Contiguity (0, 1, 2, 3... — no gaps!)
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i) {
      throw createError(
        `Step positions must be contiguous starting at 0. Found gap at position ${i}`,
        400,
      );
    }
  }

  // 3. Exactly one trigger at position 0
  const triggers = steps.filter((s) => s.stepType === 'trigger');
  if (triggers.length !== 1 || triggers[0].position !== 0) {
    throw createError('A zap must have exactly one trigger step at position 0', 400);
  }

  // 4. Validate Step Type Consistency
  for (const step of steps) {
    if (step.stepType === 'trigger' && !step.availableTriggerId) {
      throw createError('Trigger step must specify availableTriggerId', 400);
    }
    if (step.stepType === 'trigger' && step.availableActionId) {
      throw createError('Trigger step must not specify availableActionId', 400);
    }
    if ((step.stepType === 'action' || step.stepType === 'filter') && step.availableTriggerId) {
      throw createError('Action/filter steps must not specify availableTriggerId', 400);
    }
  }
}
```

---

## 8.5 The Secret Concealment Pattern

When a trigger step is created, `zap.controller.ts` generates a 256-bit cryptographically secure webhook secret:
```typescript
webhookSecret: step.stepType === 'trigger'
  ? crypto.randomBytes(32).toString('hex')
  : null
```

### The Security Vulnerability:
If `GET /zaps/:id` returned `webhookSecret` in its response payload, any component displaying Zap metadata (or any logging proxy inspecting API responses) would expose the secret signing key.

### The Concealment Architecture:
1. `GET /zaps` and `GET /zaps/:id` explicitly exclude `webhookSecret` from their Prisma `select` clauses:
   ```typescript
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
     // webhookSecret is NOT selected!
   }
   ```
2. A separate, authenticated endpoint exists exclusively for revealing the secret on demand when the user sets up their webhook:
   `GET /zaps/:id/steps/:stepId/webhook-secret`

---

## 8.6 Step Deletion & Atomic Position Resequencing

If a user configures a 4-step Zap ($Position = 0, 1, 2, 3$) and deletes Step 1, the remaining steps are left at positions $0, 2, 3$. This violates the contiguity invariant ($0, 1, 2$).

If the backend executed individual `UPDATE` queries for each step, intermediate states would trigger PostgreSQL unique constraint collisions on `(zap_id, position)`:
- Updating Step 2 to Position 1 might fail if another row is momentarily at Position 1!

### The Atomic Batch Resequence Query:
In `deleteStep` (`apps/app-api/src/controllers/zap.controller.ts`):

```typescript
await prisma.$transaction(async (tx) => {
  // 1. Delete the targeted step
  await tx.zapStep.delete({ where: { id: stepId } });

  // 2. Sort remaining steps by their old position
  const remaining = zap.steps
    .filter((s) => s.id !== stepId)
    .sort((a, b) => a.position - b.position);

  if (remaining.length > 0) {
    // 3. Build a PostgreSQL VALUES table: (id, new_position)
    const values = remaining
      .map((s, i) => `(${s.id}::bigint, ${i})`)
      .join(', ');

    // 4. Atomic multi-row update via FROM VALUES
    await tx.$executeRawUnsafe(`
      UPDATE zap_steps AS t
      SET position = v.new_pos
      FROM (VALUES ${values}) AS v(id, new_pos)
      WHERE t.id = v.id AND t.position != v.new_pos
    `);
  }
});
```

Using PostgreSQL's `UPDATE ... FROM (VALUES ...)` syntax:
- All step position reassignments happen simultaneously in a single atomic SQL statement.
- Zero constraint collisions occur.
- Exactly one database query replaces $N$ individual network roundtrips.

---

## 8.7 Frontend Architecture & Run History Timeline (`apps/web`)

The frontend application (`apps/web`) is built with Next.js 14 and Tailwind CSS.

### Key Pages and Components:
1. **`/dashboard/zaps`:** Displays list of active/inactive workflows, execution counts, and quick-toggle switches.
2. **`/dashboard/zaps/[zapId]`:** The Visual Zap Builder. Supports dynamic step configuration, connector selection, and the mustache token picker.
3. **`/dashboard/zaps/[zapId]/runs`:** The Run History Timeline.

```mermaid
graph TD
    subgraph Run Timeline UI
        R1[Run #501 - Status: COMPLETED<br/>Started: 10:14:02 AM - Duration: 1.2s]
        R1 --> S0[Step 0: Trigger - Catch Hook<br/>Output: { payment: { amount: 5000 } }]
        S0 --> S1[Step 1: Filter - Amount > 1000<br/>Status: PASSED]
        S1 --> S2[Step 2: Action - Slack Post Message<br/>Output: { ok: true, ts: '1720001...' }]
    end
```

### The Diagnostic Benefit:
When a customer asks *"Why didn't my Zap fire?"*, the operator opens `/runs`:
- If the run status is `filtered`, they immediately see that Step 1 evaluated to `false`.
- If the status is `ambiguous`, they see the exact timeout code (`ECONNABORTED`) and can manually verify the downstream system before retrying.

In Chapter 9, we inspect the connector catalog and the mechanics of writing custom adapters.
