# Deep Dive 6 — Database Schema, Migrations & Shared Packages: Every Line Explained

> This chapter dissects the entire PostgreSQL schema, explaining why every column, constraint,
> index, and FK exists. It covers the two migrations (initial schema + `queued` status addition),
> the CHECK constraints that Prisma can't express, the partial unique index, the `ZapRunRequestedEvent`
> wire format, the shared DB client singleton, and the Zod-validated env config system.

---

## Table of Contents

1. [Schema Philosophy — Six Layers of Data](#1-schema-philosophy--six-layers-of-data)
2. [Layer 1: `users` Table](#2-layer-1-users-table)
3. [Layer 2: `connectors`, `available_triggers`, `available_actions` — The Catalog](#3-layer-2-connectors-available_triggers-available_actions--the-catalog)
4. [Layer 3: `connections` — User Credentials](#4-layer-3-connections--user-credentials)
5. [Layer 4: `zaps` and `zap_steps` — The Automation](#5-layer-4-zaps-and-zap_steps--the-automation)
6. [Layer 5: `webhook_events` and `outbox` — Ingestion Pipeline](#6-layer-5-webhook_events-and-outbox--ingestion-pipeline)
7. [Layer 6: `zap_runs` and `zap_run_steps` — Execution History](#7-layer-6-zap_runs-and-zap_run_steps--execution-history)
8. [Migration 2: Adding the `queued` Status](#8-migration-2-adding-the-queued-status)
9. [Prisma Schema: What It Can and Cannot Express](#9-prisma-schema-what-it-can-and-cannot-express)
10. [`packages/types`: The Kafka Wire Format](#10-packagestypes-the-kafka-wire-format)
11. [`packages/db`: The Prisma Singleton](#11-packagesdb-the-prisma-singleton)
12. [Environment Variable Validation with Zod](#12-environment-variable-validation-with-zod)

---

## 1. Schema Philosophy — Six Layers of Data

The schema is organized into six conceptual layers, each building on the previous:

```
Layer 1: Identity          → users
Layer 2: App Catalog       → connectors, available_triggers, available_actions
Layer 3: User Credentials  → connections
Layer 4: The Automation    → zaps, zap_steps
Layer 5: Ingestion         → webhook_events, outbox
Layer 6: Execution         → zap_runs, zap_run_steps
```

Data flows downward through the layers:
- A `user` (Layer 1) creates a `connection` (Layer 3) using a `connector` (Layer 2)
- The user creates a `zap` (Layer 4) with `steps` (Layer 4) referencing catalog items (Layer 2)
  and the connection (Layer 3)
- When a webhook fires, a `webhook_event` (Layer 5) is created and an `outbox` entry (Layer 5)
  is added for dispatch
- The worker creates a `zap_run` (Layer 6) and `zap_run_steps` (Layer 6) as it executes

No layer references a layer above it. This is enforced by the FK structure — a `zap_run`
references `zap_id` and `webhook_event_id`, never a `connection` or `connector` directly.

---

## 2. Layer 1: `users` Table

```sql
CREATE TABLE "users" (
    "id"            BIGSERIAL PRIMARY KEY,
    "name"          VARCHAR(100) NOT NULL,
    "email"         VARCHAR(255) UNIQUE NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `BIGSERIAL` — why not UUID?

**`BIGSERIAL`** is an auto-incrementing 64-bit integer (`BIGINT` + a sequence). The alternatives:
- `SERIAL` (32-bit) — max 2.1 billion. A large platform could hit this. Ruled out.
- `UUID` — 128-bit random value like `550e8400-e29b-41d4-a716-446655440000`. Never overflows.
  But:
  - UUIDs are 16 bytes vs BIGINT's 8 bytes. Every FK reference doubles in size.
  - UUIDs are random — they don't sort chronologically. Index pages fragment heavily over time
    (random inserts cause constant B-tree page splits).
  - UUIDs are not human-readable — "user 42" is easier to reference in support than
    "user 550e8400-e29b-41d4-a716-446655440000"
  - B-tree indexes on sequential BIGSERIAL are highly cache-friendly (new inserts go to the
    rightmost leaf page only).

**When to use UUID instead:** If IDs need to be unguessable (e.g., public API IDs you don't
want scraped), use UUID. Here, IDs are only exposed to the authenticated owner — a user can
only see their own zap IDs.

### `VARCHAR(100)` for name and `VARCHAR(255)` for email

**Why not `TEXT`?** In PostgreSQL, `VARCHAR(n)` and `TEXT` have identical storage and performance.
There is no storage overhead or performance difference. The length constraint is purely a data
quality guard — it prevents 100,000-character names from being stored (either a bug or abuse).

**`VARCHAR(255)` for email** — 255 is the maximum length of a valid email address per RFC 5321.
Using `VARCHAR(255)` both enforces the limit and signals intent to future maintainers.

### `TEXT` for `password_hash` (no length limit)

bcrypt hashes are always exactly 60 characters (using the `$2b$` prefix format). We could use
`VARCHAR(60)`. But `TEXT` is used because:
1. If the hashing algorithm changes (bcrypt → Argon2), the hash length changes too.
2. `TEXT` avoids a future migration to change the column length.
3. No query ever searches by `password_hash`, so there's no index on it — the length restriction
   provides no performance benefit.

### `TIMESTAMPTZ` — timezone-aware timestamps

`TIMESTAMPTZ` (timestamp with time zone) stores timestamps in UTC internally and displays them
in the client's timezone. `TIMESTAMP` (without timezone) stores the raw timestamp with no
timezone context — meaning "2024-01-15 10:00:00" is ambiguous (UTC? EST? IST?).

**All timestamp columns in this schema use `TIMESTAMPTZ`.** This is best practice for any
application serving users across timezones.

---

## 3. Layer 2: `connectors`, `available_triggers`, `available_actions` — The Catalog

### `connectors` table

```sql
CREATE TABLE "connectors" (
    "id"                       VARCHAR(50) PRIMARY KEY,
    "auth_type"                VARCHAR(20) NOT NULL DEFAULT 'oauth'
                                  CHECK ("auth_type" IN ('oauth', 'api_key')),
    "auth_url"                 TEXT,
    "token_url"                TEXT,
    "scopes"                   TEXT[] NOT NULL DEFAULT '{}',
    "supports_idempotency_key" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "oauth_fields_required" CHECK (
        "auth_type" = 'api_key' OR ("auth_url" IS NOT NULL AND "token_url" IS NOT NULL)
    )
);
```

**`id` is a `VARCHAR(50)` human-readable string** — not a BIGSERIAL. Connector IDs are
`'slack'`, `'github'`, `'razorpay'`. These are the same IDs used in adapter registration
(`registerAdapter({ actionId: 'slack:send-message' })`). Using a string PK ensures the
connector ID in the DB matches the adapter ID in code without any mapping layer.

**The `oauth_fields_required` CHECK constraint:**
```
auth_type = 'api_key' OR (auth_url IS NOT NULL AND token_url IS NOT NULL)
```
Read as: "Either this is an API key connector (no OAuth URLs needed), OR it's an OAuth connector
which requires BOTH `auth_url` and `token_url`."

This is a conditional requirement — the rule is `auth_type → fields_required`. Without this
constraint, someone could insert an `oauth` connector without specifying where to redirect the
user for authorization (missing `auth_url`) — the OAuth flow would silently fail.

**`scopes TEXT[]`** — PostgreSQL native array type. Stores OAuth scopes like
`{'chat:write', 'channels:read'}`. This avoids needing a separate `connector_scopes` junction
table for a simple one-to-many list. Arrays work well here because scopes are never individually
queried — they're always read as a set.

### `available_triggers` and `available_actions`

```sql
CREATE TABLE "available_triggers" (
    "id"             VARCHAR(50) PRIMARY KEY,   -- e.g. "razorpay:payment.captured"
    "connector_id"   VARCHAR(50) NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
    "payload_schema" JSONB,
    UNIQUE ("connector_id", "name")
);
```

**`REFERENCES "connectors"("id") ON DELETE CASCADE`** — if a connector is deleted from the
catalog, all its triggers and actions are also deleted. This prevents orphaned triggers with no
parent connector. In practice, connectors are never deleted (they're part of the product catalog),
but the cascade rule enforces referential integrity.

**`JSONB` for `payload_schema` and `input_schema`** — these columns store JSON Schema objects.
`JSONB` (binary JSON) vs `JSON` (text JSON):
- `JSONB` is stored in a parsed binary format — faster for read access and operators
- `JSONB` normalizes whitespace and key ordering — two schemas that are semantically identical
  store identically
- `JSONB` supports GIN indexes for querying inside the JSON
- `JSON` preserves the original text exactly — useful when order matters, but slower

We use `JSONB` everywhere. We never need to preserve JSON text exactly, and `JSONB`'s queryability
would allow future features like "find all actions that have an `amount` field in their schema."

---

## 4. Layer 3: `connections` — User Credentials

```sql
CREATE TABLE "connections" (
    "access_token"         TEXT,
    "refresh_token"        TEXT,
    "api_key"              TEXT,
    "api_secret"           TEXT,
    ...
    CONSTRAINT "auth_fields_match_type" CHECK (
        ("access_token" IS NOT NULL AND "refresh_token" IS NOT NULL AND "api_key" IS NULL) OR
        ("api_key" IS NOT NULL AND "access_token" IS NULL AND "refresh_token" IS NULL)
    )
);
```

### The `auth_fields_match_type` CHECK constraint

This is the DB-level enforcement of "a connection is either OAuth OR API key, never both."

**Column meanings:**
- `access_token` + `refresh_token` → OAuth connection (both must be present together)
- `api_key` → API key connection (may optionally have `api_secret`)

**The constraint logic:**
```
(access_token IS NOT NULL AND refresh_token IS NOT NULL AND api_key IS NULL)
  OR
(api_key IS NOT NULL AND access_token IS NULL AND refresh_token IS NULL)
```

This prevents:
- A row with `access_token` set AND `api_key` set (mixed auth)
- A row with `access_token` set but `refresh_token` null (incomplete OAuth)
- A row with all credential fields null (no credentials at all)

**Why CHECK and not application-level validation?** Application code can have bugs. A developer
might forget to validate before inserting. The DB constraint is the last line of defense —
it CANNOT be bypassed by buggy application code.

**Prisma can't express this constraint** — Prisma schema syntax has no way to write cross-column
conditional CHECK constraints. The note in `schema.prisma` says:
```
// NOTE: auth_fields_match_type CHECK constraint is enforced in the migration SQL.
```
The constraint lives only in the migration SQL.

### `UNIQUE (user_id, connector_id, external_account_id)`

This three-column unique key prevents a user from having two identical OAuth connections to the
same account in the same connector. `external_account_id` is the provider's account identifier
(Slack workspace ID, GitHub username, etc.). The upsert in `oauthCallback` uses this key.

**Without this unique key:** A user reconnecting Slack would create a duplicate connection. Two
`connections` rows for the same Slack workspace. Zap steps referencing the "old" connection would
use stale tokens. The upsert pattern only works because this unique key exists.

### `ON DELETE CASCADE` for `user_id` FK

```sql
"user_id" BIGINT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE
```

When a user deletes their account, all their connections are automatically deleted. Without
cascade, deleting a user with connections would fail with a FK constraint violation — you'd have
to manually delete all connections first.

**No cascade on `connector_id` FK** — if a connector is ever removed from the catalog, the
existing connections to that connector should NOT be automatically deleted. Users who have
connected a now-removed connector should still see their connection (to know it existed). The
missing cascade means you'd get a FK violation if you tried to delete a connector with existing
user connections — which is the correct behavior (the deletion should fail gracefully).

---

## 5. Layer 4: `zaps` and `zap_steps` — The Automation

### The partial unique index — most important index in the schema

```sql
-- Partial unique index: only one trigger step per zap
CREATE UNIQUE INDEX "one_trigger_per_zap" ON "zap_steps"("zap_id") WHERE "step_type" = 'trigger';
```

**What a partial index is:** A regular index covers every row in the table. A partial index covers
only rows matching a `WHERE` clause. `WHERE step_type = 'trigger'` means only rows where the
step is a trigger are indexed.

**Why this enforces "one trigger per zap":** The index is `UNIQUE` on `zap_id`. Among rows where
`step_type = 'trigger'`, every `zap_id` must be unique. Attempting to insert a second trigger
for the same zap fails with a unique constraint violation.

**Why not a regular UNIQUE on `(zap_id, step_type)` where `step_type = 'trigger'`?** Because
that would also enforce uniqueness of action steps — only one action per zap. We want:
- Exactly ONE trigger per zap (use partial index, enforced at DB level)
- UNLIMITED action/filter steps per zap (no constraint)

**Prisma cannot express partial indexes.** The note in `schema.prisma`:
```
// NOTE: UNIQUE INDEX one_trigger_per_zap (partial: WHERE step_type = 'trigger')
// → defined in migrations, not expressible in Prisma schema
```

Prisma's `@@unique([zapId])` would be a full unique index on `zap_id` — meaning only one step
total per zap! Wrong. So the partial index lives only in the migration SQL.

### `zap_steps` CHECK constraints

```sql
CHECK (
  ("step_type" = 'trigger' AND "available_trigger_id" IS NOT NULL AND "available_action_id" IS NULL) OR
  ("step_type" IN ('action','filter') AND "available_trigger_id" IS NULL)
)
```

This enforces at the DB level:
1. **Trigger steps** must have `available_trigger_id` set (what they're triggered by) and must
   NOT have `available_action_id` set (they're not actions).
2. **Action and filter steps** must NOT have `available_trigger_id` set.

**`available_action_id` for action steps is intentionally NOT required here.** Action and filter
steps can have `available_action_id = NULL` (during draft/configuration state). The application-
level validation in `validateZapSteps` enforces that finished zaps have proper configuration.
The DB constraint enforces only the structural impossibility (a trigger can't be an action).

```sql
CONSTRAINT "webhook_secret_only_on_trigger"
  CHECK ("step_type" = 'trigger' OR "webhook_secret" IS NULL)
```

Only trigger steps have webhook secrets. This prevents action steps from having a
`webhook_secret` set, which would be meaningless (action steps receive no webhooks).

### `config JSONB NOT NULL DEFAULT '{}'`

The `config` column stores the step's template configuration — for example:
```json
{ "channel": "#alerts", "text": "Payment {{step_1.amount}} received" }
```

**`NOT NULL DEFAULT '{}'`** — config is always present, defaulting to an empty object. The
worker's template substitution code expects `config` to be a `Record<string, unknown>` — never
`null`.

**`JSONB` allows querying inside config** — e.g., you could find all steps that reference
`step_1.amount` with a JSONB contains operator. Not currently used but possible.

---

## 6. Layer 5: `webhook_events` and `outbox` — Ingestion Pipeline

### `webhook_events` — the deduplication table

```sql
CREATE TABLE "webhook_events" (
    "id"          BIGSERIAL PRIMARY KEY,
    "event_id"    VARCHAR(255) NOT NULL,
    "zap_id"      BIGINT NOT NULL REFERENCES "zaps"("id") ON DELETE CASCADE,
    "payload"     JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("event_id", "zap_id")
);
```

**`UNIQUE ("event_id", "zap_id")`** — this is the idempotency key for webhook ingestion. When
`hooks-api` receives a webhook, it calls:
```sql
INSERT INTO webhook_events (event_id, zap_id, payload)
VALUES ($1, $2, $3)
ON CONFLICT (event_id, zap_id) DO NOTHING
RETURNING id
```

If the same webhook fires twice (GitHub sends duplicates, or our service had a retry), the second
INSERT returns 0 rows (conflict). The hooks-api handler detects this and returns 200 without
creating a duplicate outbox entry.

**`event_id` is NOT globally unique** — the same `event_id` from GitHub (`X-GitHub-Delivery`)
could be shared across different zaps of different users (if two users have the same GitHub
webhook). The `(event_id, zap_id)` pair must be unique — not `event_id` alone.

### `outbox` — the transactional relay table

```sql
CREATE TABLE "outbox" (
    "webhook_event_id" BIGINT NOT NULL UNIQUE REFERENCES "webhook_events"("id") ON DELETE CASCADE,
    "status"           VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK ("status" IN ('pending','dispatched','consumed','dead')),
    "attempts"         INT NOT NULL DEFAULT 0,
    "max_attempts"     INT NOT NULL DEFAULT 10,
    "consumed_at"      TIMESTAMPTZ,
    ...
);
CREATE INDEX "idx_outbox_status_created" ON "outbox"("status", "created_at");
```

**`UNIQUE webhook_event_id`** — exactly one outbox row per webhook event. This is the
one-to-one relationship: one event → one outbox entry → one Kafka message → one zap run.

**The composite index `(status, created_at)`:** The relay's polling query:
```sql
SELECT ... FROM outbox
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 100
FOR UPDATE OF o SKIP LOCKED
```

This query filters by `status` AND orders by `created_at`. The composite index
`(status, created_at)` allows PostgreSQL to:
1. Use the index to jump directly to rows with `status = 'pending'`
2. Return them already sorted by `created_at` (no separate sort step)

Without this index, every poll sweep would do a full table scan of all outbox rows.

**`ON DELETE CASCADE` for `webhook_event_id`** — if the webhook event is deleted, the outbox
entry is also deleted. This maintains referential integrity and allows cleanup jobs to delete
old webhook events without having to first delete outbox entries.

**`attempts` and `max_attempts`** — `attempts` tracks how many times the relay has tried to
dispatch this row. `max_attempts = 10` is the dead-letter threshold. After 10 failed attempts,
the row is marked `dead` by the relay's error handling. See DD2 §7 for the full dead-letter flow.

---

## 7. Layer 6: `zap_runs` and `zap_run_steps` — Execution History

### `zap_runs` — the run record

```sql
CREATE TABLE "zap_runs" (
    "id"               BIGSERIAL PRIMARY KEY,
    "webhook_event_id" BIGINT NOT NULL REFERENCES "webhook_events"("id"),
    "status"           VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                         CHECK ("status" IN ('in_progress','completed','failed','filtered')),
    "step_snapshot"    JSONB,
    "started_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "completed_at"     TIMESTAMPTZ,
    CONSTRAINT "uniq_webhook_event" UNIQUE ("webhook_event_id")
);
```

**`UNIQUE (webhook_event_id)`** — exactly one run per webhook event. This is the worker's
idempotency key. When the Kafka consumer receives a message, it tries to INSERT a run row. If the
`UNIQUE` constraint fires (row already exists), it knows this message was already processed.
See DD3 §3 for the full idempotency flow.

**`step_snapshot JSONB`** — stores the state of `zap_steps` at the moment the run started.
See DD3 §3 for the full explanation of why immutable snapshots are essential for crash recovery.

**`started_at` vs `completed_at`** — `started_at = now()` when the run row is created (at
webhook receipt time, not when the worker starts processing). `completed_at` is set when the run
transitions to a terminal state (`completed`, `failed`, `filtered`).

`completedAt - startedAt` = total end-to-end latency from webhook receipt to execution complete.
This metric is important for SLA monitoring.

**`completed_at` nullable** — while the run is in-progress, `completed_at = NULL`. The UI can
detect "this run is still executing" by checking `completedAt === null`.

**No FK for `webhook_event_id` ON DELETE CASCADE** — unlike the outbox, the zap_run does NOT
cascade on webhook event deletion. Run history should be preserved even after the webhook event
is cleaned up. The run is the historical record of what happened; the webhook event is the raw
input. Runs are only deleted when the zap itself is deleted (`zap_id` ON DELETE CASCADE).

### `zap_run_steps` — the step execution record

```sql
CREATE TABLE "zap_run_steps" (
    "id"               BIGSERIAL PRIMARY KEY,
    "zap_run_id"       BIGINT NOT NULL REFERENCES "zap_runs"("id") ON DELETE CASCADE,
    "zap_step_id"      BIGINT NOT NULL REFERENCES "zap_steps"("id"),
    "status"           VARCHAR(20) NOT NULL DEFAULT 'processing'
                         CHECK ("status" IN ('processing','completed','failed','ambiguous')),
    "output"           JSONB,
    "error_code"       VARCHAR(50),
    "error_message"    TEXT,
    "idempotency_key"  UUID NOT NULL DEFAULT gen_random_uuid(),
    "claimed_at"       TIMESTAMPTZ,
    "worker_id"        VARCHAR(100),
    "executed_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("zap_run_id", "zap_step_id")
);
```

**`UNIQUE (zap_run_id, zap_step_id)`** — the distributed step lock. Only one worker can claim
a `(run, step)` pair. The INSERT in `claim.service.ts` uses `ON CONFLICT DO NOTHING` against
this unique key. See DD3 §5 for the full claim flow.

**`idempotency_key UUID DEFAULT gen_random_uuid()`** — auto-generated UUID at the time the
step row is inserted (when the step is first claimed). This UUID is passed to the connector
adapter as the `X-Idempotency-Key` header (for providers like Razorpay that support it).

**`gen_random_uuid()`** requires the `pgcrypto` extension — hence `CREATE EXTENSION IF NOT EXISTS
pgcrypto` at the top of the migration. Without pgcrypto, `gen_random_uuid()` is undefined.

**`worker_id VARCHAR(100)`** — records which worker instance claimed the step
(`worker-12345-1728738400000`). Useful for debugging: "which container was executing this step
when it got stuck?"

**`claimed_at TIMESTAMPTZ`** — nullable. Set when the step is first claimed. Updated by
`releaseWithDelay()` when a step is rate-limited. The relay job reads this to detect expired
leases (`claimedAt < NOW() - INTERVAL '2 minutes'`).

**Four step statuses:**

| Status | Meaning | Terminal? |
|--------|---------|-----------|
| `processing` | Claimed, executing (or waiting for rate limit) | No |
| `completed` | Step finished successfully | Yes |
| `failed` | Step failed with known error code | Yes |
| `ambiguous` | Lease expired — outcome unknown | Yes |

**`output JSONB`** — the step's result payload (e.g., `{ ok: true, ts: "1728738400.123" }` for
Slack, `{ id: "pay_link_123" }` for Razorpay). Stored as JSONB so it can be queried and displayed
in the execution history UI.

**`error_message TEXT` (not VARCHAR)** — error messages can be long (full error descriptions
from external APIs). Using `TEXT` prevents truncation.

---

## 8. Migration 2: Adding the `queued` Status

**File:** `packages/db/prisma/migrations/20260803120000_add_queued_status/migration.sql`

```sql
-- Alter the default status for zap_runs
ALTER TABLE "zap_runs" ALTER COLUMN "status" SET DEFAULT 'queued';

-- Drop the old constraint
ALTER TABLE "zap_runs" DROP CONSTRAINT IF EXISTS "zap_runs_status_check";

-- Add the new constraint with 'queued'
ALTER TABLE "zap_runs" ADD CONSTRAINT "zap_runs_status_check"
  CHECK ("status" IN ('queued', 'in_progress', 'completed', 'failed', 'filtered'));
```

**Why a second migration?** The `queued` status was introduced when the worker's `onMessage`
was refactored. The original flow: worker receives Kafka message → immediately INSERT a new
`zap_run` with `in_progress` status.

The problem: the `hooks-api` also needs to create a `zap_run` row (with `queued` status) at
webhook ingestion time. This allows the frontend to show "Pending" for runs that are in the
queue before the worker picks them up. The original design didn't have this state.

**`IF NOT EXISTS` for safety** — `DROP CONSTRAINT IF EXISTS` prevents the migration from
failing if the constraint was already dropped (e.g., if the migration is re-run manually).

**Changing the `DEFAULT` separately from the CHECK** — the two ALTER statements are independent:
1. `ALTER COLUMN "status" SET DEFAULT 'queued'` — new runs default to `queued` (not `in_progress`)
2. DROP + ADD CONSTRAINT — expands the allowed values to include `queued`

They must be done in order: if you add `queued` to the constraint but forget to change the
default, new rows would default to `in_progress` (which was the old behavior). Getting the default
right is as important as the constraint.

**Why DROP and re-ADD the constraint?** PostgreSQL doesn't support `ALTER CONSTRAINT ... CHECK`.
To change a CHECK constraint's allowed values, you must drop the old one and add a new one.

---

## 9. Prisma Schema: What It Can and Cannot Express

The `schema.prisma` comment at the top is unusually important:

```prisma
// Notes on raw SQL usage:
//   - FOR UPDATE SKIP LOCKED → $queryRaw in relay/src/poller/outbox-poller.ts
//   - INSERT ... ON CONFLICT DO NOTHING RETURNING → $queryRaw in worker/src/services/claim.service.ts
//   - Partial index (one_trigger_per_zap) → defined in migrations, not expressible in Prisma schema
```

### What Prisma CAN express:

| Feature | Prisma Syntax | SQL |
|---------|--------------|-----|
| Primary key | `@id @default(autoincrement())` | `BIGSERIAL PRIMARY KEY` |
| Unique column | `@unique` | `UNIQUE` |
| Composite unique | `@@unique([a, b])` | `UNIQUE (a, b)` |
| FK + cascade | `@relation(onDelete: Cascade)` | `REFERENCES ... ON DELETE CASCADE` |
| Default | `@default(now())` | `DEFAULT now()` |
| Index | `@@index([a, b])` | `CREATE INDEX ... ON (a, b)` |
| JSON type | `Json` | `JSONB` |
| Enum-like | String with validation | N/A |

### What Prisma CANNOT express (must be in raw SQL migrations):

| Feature | Why Not in Prisma |
|---------|------------------|
| `PARTIAL INDEX ... WHERE step_type = 'trigger'` | No partial index support in Prisma schema |
| Multi-column cross-field CHECK constraint | Prisma has no `@@check` annotation |
| `FOR UPDATE SKIP LOCKED` | No Prisma query API for advisory locking |
| `ON CONFLICT DO NOTHING RETURNING` | Prisma's upsert doesn't support this pattern |
| `gen_random_uuid()` as default | Prisma uses `@default(dbgenerated("gen_random_uuid()"))` but not all DB functions are supported |

**The `@@map` annotation** — Prisma uses PascalCase model names (`ZapRun`) internally while the
DB uses snake_case table names (`zap_runs`). `@@map("zap_runs")` tells Prisma the actual table
name. Similarly `@map("created_at")` maps camelCase Prisma fields to snake_case DB columns.

### Prisma `binaryTargets`

```prisma
generator client {
  binaryTargets = ["native", "linux-musl-openssl-3.0.x", "linux-musl-arm64-openssl-1.1.x", ...]
}
```

Prisma generates platform-specific query engine binaries (written in Rust). The `binaryTargets`
list tells Prisma which platforms to generate binaries for:
- `"native"` — the current developer's machine (Mac, Windows)
- `"linux-musl-openssl-3.0.x"` — Alpine Linux (used in Docker containers), OpenSSL 3.0
- `"linux-musl-arm64-openssl-1.1.x"` — ARM64 Alpine (e.g., Apple Silicon Docker, AWS Graviton)

Without the correct binary target, the Docker container would fail to start with "Prisma Client
could not locate the Query Engine for runtime linux-musl." The multiple targets support running
the same code on developer machines AND in Linux Docker containers.

---

## 10. `packages/types`: The Kafka Wire Format

**File:** `packages/types/src/kafka-events/zap-run-requested.event.ts`

```typescript
/** Message published to Kafka topic: zap.run.requested */
export interface ZapRunRequestedEvent {
  webhookEventId: string; // bigint serialized as string for JSON safety
  zapId: string;
  userId: string;
  payload: Record<string, unknown>;
  receivedAt: string; // ISO 8601
}
```

### Why strings, not numbers, for IDs?

**The bigint JSON problem on the wire:** Kafka messages are serialized as JSON strings. JSON
has no `bigint` type — `JSON.stringify(42n)` throws. Even if it didn't throw, a JSON number
like `9007199254740993` (2^53 + 1) would be parsed by JavaScript's `JSON.parse` as
`9007199254740992` (losing the last bit due to floating-point precision).

**The solution:** Store all IDs as strings in the Kafka message. `webhookEventId: "42"` is
always parsed back as the exact string `"42"`, then converted with `BigInt("42")` to the native
bigint `42n` in the worker.

**The `// bigint serialized as string` comment** is critical documentation. Without it, a future
developer might change the type to `number` thinking strings are unnecessary. The comment
explains WHY strings are used.

**`receivedAt: string // ISO 8601`** — timestamps are serialized as ISO 8601 strings
(`"2024-10-12T04:00:00.000Z"`). JSON has no date type — `Date` objects serialize as ISO strings
in `JSON.stringify`. The worker parses this with `new Date(event.receivedAt)` if needed.

### How the event is produced (relay) and consumed (worker)

**Relay produces:**
```typescript
await producer.send({
  topic: 'zap.run.requested',
  messages: [{
    key: row.userId.toString(),  // Partition key → same user always same partition
    value: JSON.stringify({
      webhookEventId: row.webhookEventId.toString(),
      zapId: row.zapId.toString(),
      userId: row.userId.toString(),
      payload: row.payload,
      receivedAt: row.createdAt.toISOString(),
    } satisfies ZapRunRequestedEvent),  // Type-check at compile time
  }]
});
```

**`satisfies ZapRunRequestedEvent`** — TypeScript 4.9+ `satisfies` operator. Unlike `as
ZapRunRequestedEvent` (which bypasses type checking), `satisfies` verifies that the object
literal matches the interface, while still inferring the narrowest type. If you misspell
`webhookEventId`, TypeScript catches it at compile time.

**Worker consumes:**
```typescript
const event = JSON.parse(message.value.toString()) as ZapRunRequestedEvent;
const webhookEventId = BigInt(event.webhookEventId);  // "42" → 42n
const zapId = BigInt(event.zapId);
```

The `as ZapRunRequestedEvent` type cast here is looser than `satisfies` — it doesn't verify the
object matches the interface. This is acceptable because the message comes from a trusted source
(our own relay service) and was validated at production time.

### The `packages/types` barrel export pattern

```typescript
// packages/types/src/index.ts
export * from './entities/index';
export * from './kafka-events/zap-run-requested.event';
export * from './connector-schemas/slack';
export * from './connector-schemas/razorpay';
```

`export * from './file'` re-exports everything from `file`. This is the **barrel pattern** —
consumers import from the package root (`@zapier-clone/types`) and get all exports:

```typescript
import { ZapRunRequestedEvent } from '@zapier-clone/types';  // works
// vs without barrel:
import { ZapRunRequestedEvent } from '@zapier-clone/types/src/kafka-events/zap-run-requested.event';
// (brittle, exposes internal structure)
```

The barrel allows internal reorganization without breaking consumers.

---

## 11. `packages/db`: The Prisma Singleton

**File:** `packages/db/src/index.ts`

```typescript
import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

**Why a singleton?** Prisma's `PrismaClient` maintains a connection pool to the database. Each
`new PrismaClient()` creates a new pool. If you create multiple clients (e.g., one per request),
you exhaust the database's maximum connection limit (typically 100 connections for Postgres).

With the singleton pattern, there's exactly ONE `PrismaClient` per process. All queries from
all route handlers, middleware, and cron jobs share the same connection pool.

**`global as unknown as { prisma: PrismaClient }`** — the global singleton pattern for
development hot-reload. In production, each process starts fresh — no global state from a
previous process. But in development with `ts-node --watch`, the module is re-evaluated on
every file save. Without the global guard, every reload would create a new `PrismaClient`
(leaking connections). Storing the client in `global` means re-evaluation finds the existing
client: `globalForPrisma.prisma ?? new PrismaClient()`.

**`if (process.env.NODE_ENV !== 'production') { globalForPrisma.prisma = prisma; }`** — only
store in global during development. In production, modules are loaded once and never re-evaluated.
The global assignment is unnecessary overhead in production.

**`log: ['query', 'error']` in development** — prints every SQL query to stdout in development.
This is invaluable for debugging ("why is this endpoint making 10 queries instead of 1?") but
would flood logs in production. In production, only `['error']` is logged.

The package exports both `prisma` (the client) and the Prisma types:
```typescript
export { prisma };
export * from '@prisma/client';  // Re-exports Prisma types (PrismaClientKnownRequestError, etc.)
```

This allows all services to import from `@zapier-clone/db` instead of directly from
`@prisma/client`, centralizing the dependency.

---

## 12. Environment Variable Validation with Zod

Each service has its own `src/config/env.ts`. Here's the pattern (from `app-api`):

```typescript
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL:       z.string().url(),
  JWT_SECRET:         z.string().min(32),
  JWT_EXPIRES_IN:     z.string().default('7d'),
  ENCRYPTION_KEY:     z.string().length(64).regex(/^[0-9a-f]+$/i),
  WEB_APP_URL:        z.string().url(),
  APP_API_PORT:       z.coerce.number().int().positive().default(3001),
  SENTRY_DSN:         z.string().url().optional(),
  OAUTH_CLIENT_CONFIGS: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌  Invalid environment variables:\n', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
```

### Fail-fast on startup

**`process.exit(1)` on invalid config** — if `JWT_SECRET` is missing or `DATABASE_URL` is
malformed, the process exits IMMEDIATELY at startup, before serving any requests. This is called
"fail-fast."

**The alternative (don't validate):** The service starts. The first request that needs
`JWT_SECRET` throws `TypeError: Cannot read property 'sign' of undefined`. The error bubbles
up as a 500 response. The logs show an unhelpful error. The operator doesn't know the real
problem is a missing env var.

With fail-fast Zod validation, the startup log shows:
```
❌  Invalid environment variables:
{
  "JWT_SECRET": { "_errors": ["Required"] },
  "DATABASE_URL": { "_errors": ["Invalid url"] }
}
```
The misconfiguration is immediately obvious.

### `z.coerce.number()` for port

```typescript
APP_API_PORT: z.coerce.number().int().positive().default(3001),
```

Environment variables are always strings (`process.env.APP_API_PORT = "3001"`). Without coerce,
`z.number()` would reject `"3001"`. With `z.coerce.number()`, Zod converts `"3001"` → `3001`
before validation. The exported `env.APP_API_PORT` is a `number`, not a string — no manual
`parseInt` needed.

### `ENCRYPTION_KEY` validation

```typescript
ENCRYPTION_KEY: z.string().length(64).regex(/^[0-9a-f]+$/i),
```

The AES-256-GCM key is a 32-byte key stored as a 64-character hex string. Zod validates:
- `.length(64)` — must be exactly 64 characters
- `.regex(/^[0-9a-f]+$/i)` — must be valid hex (only 0-9 and a-f, case-insensitive)

If someone sets `ENCRYPTION_KEY=my_secret_key` (ASCII, wrong format), the service refuses to
start. Without this validation, the `Buffer.from(env.ENCRYPTION_KEY, 'hex')` call in
`encrypt.helper.ts` would produce a wrong-length key, causing every encryption to silently fail
or produce garbage.

### Service-specific env schemas

Each service validates only the env vars it needs:
- `hooks-api/env.ts` — `DATABASE_URL`, `ENCRYPTION_KEY`, `HOOKS_API_PORT`, `SENTRY_DSN`
- `relay/env.ts` — `DATABASE_URL`, `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`, `RELAY_BATCH_SIZE`
- `worker/env.ts` — `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `ENCRYPTION_KEY`,
  `WORKER_RATE_LIMIT_PER_CONNECTION`, `WORKER_LEASE_TIMEOUT_MS`
- `app-api/env.ts` — all of the above + `JWT_SECRET`, `JWT_EXPIRES_IN`, `WEB_APP_URL`,
  `OAUTH_CLIENT_CONFIGS`

Why not one global schema? If `hooks-api` required `JWT_SECRET` in its schema, it would need
the JWT secret in its environment even though it never issues JWTs. Separate schemas mean
each service is configured with only what it needs — reducing the blast radius of a
misconfigured deploy.

---

*Continue to: [DD7 — Docker Compose, Turborepo & Local Dev Infrastructure](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD7_INFRASTRUCTURE_AND_DOCKER.md)*
