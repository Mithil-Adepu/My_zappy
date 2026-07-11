-- Zapier Clone — Initial Migration
-- Generated to accompany packages/db/prisma/schema.prisma
-- Run via: pnpm --filter @zapier-clone/db db:migrate
-- Or manually: psql $DATABASE_URL < this_file.sql

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── LAYER 1: Identity ───────────────────────────────────────────────────────

CREATE TABLE "users" (
    "id"            BIGSERIAL PRIMARY KEY,
    "name"          VARCHAR(100) NOT NULL,
    "email"         VARCHAR(255) UNIQUE NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── LAYER 2: App Catalog ────────────────────────────────────────────────────

CREATE TABLE "connectors" (
    "id"                       VARCHAR(50) PRIMARY KEY,
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

CREATE TABLE "available_triggers" (
    "id"             VARCHAR(50) PRIMARY KEY,
    "connector_id"   VARCHAR(50) NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
    "name"           VARCHAR(100) NOT NULL,
    "payload_schema" JSONB,
    UNIQUE ("connector_id", "name")
);

CREATE TABLE "available_actions" (
    "id"           VARCHAR(50) PRIMARY KEY,
    "connector_id" VARCHAR(50) NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
    "name"         VARCHAR(100) NOT NULL,
    "input_schema" JSONB,
    UNIQUE ("connector_id", "name")
);

-- ─── LAYER 3: OAuth Connections ──────────────────────────────────────────────

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

CREATE INDEX "idx_connections_user_connector" ON "connections"("user_id", "connector_id");

-- ─── LAYER 4: The Zap ────────────────────────────────────────────────────────

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

-- Partial unique index: only one trigger step per zap
CREATE UNIQUE INDEX "one_trigger_per_zap" ON "zap_steps"("zap_id") WHERE "step_type" = 'trigger';
CREATE INDEX "idx_zap_steps_zap_id" ON "zap_steps"("zap_id");

-- ─── LAYER 5: Ingestion ──────────────────────────────────────────────────────

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

-- ─── LAYER 6: Execution ──────────────────────────────────────────────────────

CREATE TABLE "zap_runs" (
    "id"               BIGSERIAL PRIMARY KEY,
    "zap_id"           BIGINT NOT NULL REFERENCES "zaps"("id") ON DELETE CASCADE,
    "webhook_event_id" BIGINT NOT NULL REFERENCES "webhook_events"("id"),
    "status"           VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                         CHECK ("status" IN ('in_progress','completed','failed','filtered')),
    "step_snapshot"    JSONB,
    "started_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "completed_at"     TIMESTAMPTZ,
    CONSTRAINT "uniq_webhook_event" UNIQUE ("webhook_event_id")
);

CREATE INDEX "idx_zap_runs_zap_status" ON "zap_runs"("zap_id", "status");

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

CREATE INDEX "idx_zap_run_steps_zap_run_id" ON "zap_run_steps"("zap_run_id");
