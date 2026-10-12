# Chapter 3 — Database Schema & Relational Design

> **ZapFlow Builder's Manual & Architecture Journey**  
> *Chapter 3 of 10*

---

## 3.1 The 6-Layer Relational Topology

The database schema (`packages/db/prisma/schema.prisma` and `packages/db/prisma/migrations/0001_init.sql`) is organized into six functional layers. Each layer represents a distinct phase of tenant configuration, app catalog integration, or distributed execution.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      LAYER 1: IDENTITY & TENANTS                       │
│  [users]                                                               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 1:N
┌───────────────────────────────────▼────────────────────────────────────┐
│                      LAYER 2: CONNECTOR CATALOG                        │
│  [connectors] ──1:N──► [available_triggers]                            │
│               └──1:N──► [available_actions]                             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 1:N
┌───────────────────────────────────▼────────────────────────────────────┐
│                      LAYER 3: CREDENTIAL VAULT                         │
│  [connections] (OAuth Tokens / API Keys encrypted at rest)              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 1:N
┌───────────────────────────────────▼────────────────────────────────────┐
│                      LAYER 4: WORKFLOW DEFINITIONS                     │
│  [zaps] ──1:N──► [zap_steps] (position-indexed, single trigger)        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 1:N
┌───────────────────────────────────▼────────────────────────────────────┐
│                      LAYER 5: ASYNCHRONOUS INGESTION                   │
│  [webhook_events] ──1:1──► [outbox] (Transactional Outbox)             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 1:1
┌───────────────────────────────────▼────────────────────────────────────┐
│                      LAYER 6: WORKFLOW EXECUTION                       │
│  [zap_runs] ──1:N──► [zap_run_steps] (Idempotency keys, leases)        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3.2 Deep Dive into Schema Layers

### Layer 1: Identity & Authentication (`users`)

```sql
CREATE TABLE "users" (
    "id"            BIGSERIAL PRIMARY KEY,
    "name"          VARCHAR(100) NOT NULL,
    "email"         VARCHAR(255) UNIQUE NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- **Primary Key:** `BIGSERIAL` (64-bit signed integer).
- **Password Storage:** Salted and hashed using `bcrypt` with cost factor 12. Plaintext passwords never cross the service boundary.
- **Unique Email:** Case-insensitive lookup prevents multi-account confusion.

---

### Layer 2: The Connector Catalog (`connectors`, `available_triggers`, `available_actions`)

The catalog represents the registry of external systems supported by ZapFlow.

```sql
CREATE TABLE "connectors" (
    "id"                       VARCHAR(50) PRIMARY KEY, -- e.g. 'slack', 'razorpay', 'github'
    "name"                     VARCHAR(100) NOT NULL,
    "image_url"                TEXT,
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

- **`supports_idempotency_key`:** Indicates whether downstream endpoints honor headers like `X-Idempotency-Key` (e.g., Razorpay) or if ambiguous retries pose duplication risks (e.g., Slack).
- **`payload_schema` & `input_schema` (`JSONB`):** JSON Schema definitions describing the shape of incoming webhooks and required action inputs. Used by the web builder UI to construct field mapping pickers and by AJV to validate payloads before dispatch.

---

### Layer 3: Credentials Vault (`connections`)

Users connect third-party accounts once, generating a reusable connection record that can be linked to multiple steps across multiple Zaps.

```sql
CREATE TABLE "connections" (
    "id"                   BIGSERIAL PRIMARY KEY,
    "user_id"              BIGINT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "connector_id"         VARCHAR(50) NOT NULL REFERENCES "connectors"("id"),
    "label"                VARCHAR(100) NOT NULL,
    "external_account_id"  VARCHAR(255) NOT NULL DEFAULT 'default',
    "access_token"         TEXT,
    "refresh_token"        TEXT,
    "api_key"              TEXT,
    "api_secret"           TEXT,
    "expires_at"           TIMESTAMPTZ,
    "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("user_id", "connector_id", "external_account_id"),
    CONSTRAINT "auth_fields_match_type" CHECK (
        ("access_token" IS NOT NULL AND "refresh_token" IS NOT NULL AND "api_key" IS NULL) OR
        ("api_key" IS NOT NULL AND "access_token" IS NULL AND "refresh_token" IS NULL)
    )
);
```

#### Key Invariants & Safeguards:
1. **Encryption at Rest:** `access_token`, `refresh_token`, `api_key`, and `api_secret` store AES-256-GCM ciphertexts. Even in the event of a raw database dump leak, external provider tokens remain cryptographically unreadable without `ENCRYPTION_KEY`.
2. **Mutual Exclusivity Constraint (`auth_fields_match_type`):**  
   PostgreSQL enforces that a connection cannot simultaneously hold an OAuth token and an API key. Either OAuth credentials exist (`access_token` + `refresh_token`), or API key credentials exist (`api_key` $\pm$ `api_secret`).
3. **Multi-Account Support:** A user can connect multiple Slack workspaces or GitHub accounts thanks to the unique compound index on `(user_id, connector_id, external_account_id)`.

---

### Layer 4: The Zap Workflow Definition (`zaps`, `zap_steps`)

A Zap is a container for an ordered sequence of steps.

```sql
CREATE TABLE "zaps" (
    "id"               BIGSERIAL PRIMARY KEY,
    "user_id"          BIGINT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "name"             VARCHAR(200) NOT NULL,
    "is_active"        BOOLEAN NOT NULL DEFAULT true,
    "max_runs_per_hour" INT NOT NULL DEFAULT 100,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "zap_steps" (
    "id"                    BIGSERIAL PRIMARY KEY,
    "zap_id"                BIGINT NOT NULL REFERENCES "zaps"("id") ON DELETE CASCADE,
    "step_type"             VARCHAR(10) NOT NULL CHECK ("step_type" IN ('trigger','action','filter')),
    "position"              INT NOT NULL,
    "available_trigger_id"  VARCHAR(50) REFERENCES "available_triggers"("id"),
    "available_action_id"   VARCHAR(50) REFERENCES "available_actions"("id"),
    "connection_id"         BIGINT REFERENCES "connections"("id"),
    "config"                JSONB NOT NULL DEFAULT '{}',
    "webhook_secret"        TEXT,
    "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
      ("step_type" = 'trigger' AND "available_trigger_id" IS NOT NULL AND "available_action_id" IS NULL) OR
      ("step_type" IN ('action','filter') AND "available_trigger_id" IS NULL)
    ),
    CONSTRAINT "webhook_secret_only_on_trigger"
      CHECK ("step_type" = 'trigger' OR "webhook_secret" IS NULL),
    UNIQUE ("zap_id", "position")
);

-- Partial Unique Index: Exactly one trigger per zap
CREATE UNIQUE INDEX "one_trigger_per_zap" ON "zap_steps"("zap_id") WHERE "step_type" = 'trigger';
```

#### Crucial Database Constraints:
1. **The Partial Unique Index (`one_trigger_per_zap`):**  
   Prisma’s schema syntax cannot express SQL `WHERE` clauses on indexes. In raw PostgreSQL migration, we define:
   ```sql
   CREATE UNIQUE INDEX "one_trigger_per_zap" ON "zap_steps"("zap_id") WHERE "step_type" = 'trigger';
   ```
   This guarantees that no user, race condition, or API flaw can ever insert a second trigger step into a Zap. The database kernel physically rejects it.
2. **Step Type Exclusivity:** A step of type `trigger` *must* have `available_trigger_id` set and *must not* have `available_action_id`. Action and filter steps are prohibited from referencing trigger definitions.
3. **Secret Isolation:** `webhook_secret` is mathematically constrained to `step_type = 'trigger'`. Action and filter steps cannot possess webhook secrets.

---

### Layer 5: Asynchronous Ingestion & Outbox (`webhook_events`, `outbox`)

```sql
CREATE TABLE "webhook_events" (
    "id"          BIGSERIAL PRIMARY KEY,
    "event_id"    VARCHAR(255) NOT NULL,
    "zap_id"      BIGINT NOT NULL REFERENCES "zaps"("id") ON DELETE CASCADE,
    "payload"     JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE ("event_id", "zap_id")
);

CREATE TABLE "outbox" (
    "id"               BIGSERIAL PRIMARY KEY,
    "webhook_event_id" BIGINT NOT NULL UNIQUE REFERENCES "webhook_events"("id") ON DELETE CASCADE,
    "event_id"         VARCHAR(255) NOT NULL,
    "payload"          JSONB NOT NULL,
    "status"           VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK ("status" IN ('pending','dispatched','consumed','dead')),
    "attempts"         INT NOT NULL DEFAULT 0,
    "max_attempts"     INT NOT NULL DEFAULT 10,
    "consumed_at"      TIMESTAMPTZ,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "idx_outbox_status_created" ON "outbox"("status", "created_at");
```

- **Natural Key Deduplication:** `UNIQUE ("event_id", "zap_id")` on `webhook_events` ensures that if GitHub sends the same delivery UUID 5 times within 30 seconds, only the very first insertion succeeds. Subsequent attempts trigger `ON CONFLICT DO NOTHING`.
- **The Outbox Lifecycle:**
  $$\text{pending} \xrightarrow{\text{relay poll}} \text{dispatched} \xrightarrow{\text{worker finish}} \text{consumed}$$
  If repeated Kafka errors occur, the state transitions to `dead` upon reaching `max_attempts = 10`.

---

### Layer 6: Execution Tracking & Step Leases (`zap_runs`, `zap_run_steps`)

```sql
CREATE TABLE "zap_runs" (
    "id"               BIGSERIAL PRIMARY KEY,
    "zap_id"           BIGINT NOT NULL REFERENCES "zaps"("id") ON DELETE CASCADE,
    "webhook_event_id" BIGINT NOT NULL UNIQUE REFERENCES "webhook_events"("id"),
    "status"           VARCHAR(20) NOT NULL DEFAULT 'queued'
                         CHECK ("status" IN ('queued','in_progress','completed','failed','filtered')),
    "step_snapshot"    JSONB,
    "started_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "completed_at"     TIMESTAMPTZ
);

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

#### Crucial Execution Columns:
1. **`step_snapshot` (`JSONB`):**  
   When a run transitions from `queued` to `in_progress`, the worker captures the entire sequence of steps, their actions, schemas, and configurations into this column. This ensures **Execution Immutability**: modifying step configuration in the web dashboard never corrupts active, in-flight pipeline runs.
2. **`idempotency_key` (`UUID`):**  
   Automatically generated by PostgreSQL via `pgcrypto.gen_random_uuid()`. Passed directly into downstream API headers (e.g. `X-Idempotency-Key` for Razorpay or Stripe) so repeated network calls identify the transaction as identical.
3. **`claimed_at` & `worker_id`:**  
   Form the foundation of the distributed lease mechanism. If a worker process abruptly dies (SIGKILL / OOM), another worker identifies that `claimed_at` exceeded `WORKER_LEASE_TIMEOUT_MS = 120000` (2 minutes).

---

## 3.3 The Cross-Row Security Boundary: Connection Ownership

A common vulnerability in multi-tenant SaaS applications is **Insecure Direct Object Reference (IDOR)** at the database relationship boundary:

```
User Alice (user_id = 1) owns Zap #10.
User Bob   (user_id = 2) owns Slack Connection #99.

Can Alice configure Zap #10 to execute actions using Bob's Connection #99?
```

In relational SQL, `zap_steps.connection_id` references `connections.id`.  
A standard foreign key constraint *only validates that Connection #99 exists in the table*—it cannot verify that `Connection.user_id == Zap.user_id` because SQL foreign keys cannot compare across rows of different tables without composite primary keys!

### The Solution: Application-Layer Ownership Invariant
In `apps/app-api/src/services/connection-ownership.service.ts`:

```typescript
export async function assertConnectionOwnership(
  connectionId: bigint,
  userId: bigint,
): Promise<void> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { userId: true },
  });

  if (!connection) {
    throw createError('Connection not found', 404);
  }

  if (connection.userId !== userId) {
    throw createError('You do not have access to this connection', 403);
  }
}
```

Every API endpoint creating or modifying a Zap step (`createZap`, `addStep`, `updateStep`) strictly calls `assertConnectionOwnership()` *before* committing the write to PostgreSQL.

In Chapter 4, we examine how the ingestion gateway (`hooks-api`) leverages this schema for cryptographic verification and atomic deduplication.
