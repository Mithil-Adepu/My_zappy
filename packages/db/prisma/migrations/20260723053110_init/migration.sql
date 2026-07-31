-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connectors" (
    "id" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "image_url" TEXT,
    "auth_type" VARCHAR(20) NOT NULL DEFAULT 'oauth',
    "auth_url" TEXT,
    "token_url" TEXT,
    "scopes" TEXT[],
    "supports_idempotency_key" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "available_triggers" (
    "id" VARCHAR(50) NOT NULL,
    "connector_id" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "payload_schema" JSONB,

    CONSTRAINT "available_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "available_actions" (
    "id" VARCHAR(50) NOT NULL,
    "connector_id" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "input_schema" JSONB,

    CONSTRAINT "available_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "connector_id" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "external_account_id" VARCHAR(255) NOT NULL DEFAULT 'default',
    "access_token" TEXT,
    "refresh_token" TEXT,
    "api_key" TEXT,
    "api_secret" TEXT,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zaps" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "max_runs_per_hour" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zap_steps" (
    "id" BIGSERIAL NOT NULL,
    "zap_id" BIGINT NOT NULL,
    "step_type" VARCHAR(10) NOT NULL,
    "position" INTEGER NOT NULL,
    "available_trigger_id" VARCHAR(50),
    "available_action_id" VARCHAR(50),
    "connection_id" BIGINT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "webhook_secret" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zap_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" BIGSERIAL NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "zap_id" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" BIGSERIAL NOT NULL,
    "webhook_event_id" BIGINT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 10,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zap_runs" (
    "id" BIGSERIAL NOT NULL,
    "zap_id" BIGINT NOT NULL,
    "webhook_event_id" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    "step_snapshot" JSONB,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "zap_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zap_run_steps" (
    "id" BIGSERIAL NOT NULL,
    "zap_run_id" BIGINT NOT NULL,
    "zap_step_id" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'processing',
    "output" JSONB,
    "error_code" VARCHAR(50),
    "error_message" TEXT,
    "idempotency_key" UUID NOT NULL DEFAULT gen_random_uuid(),
    "claimed_at" TIMESTAMPTZ,
    "worker_id" VARCHAR(100),
    "executed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zap_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "available_triggers_connector_id_name_key" ON "available_triggers"("connector_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "available_actions_connector_id_name_key" ON "available_actions"("connector_id", "name");

-- CreateIndex
CREATE INDEX "idx_connections_user_connector" ON "connections"("user_id", "connector_id");

-- CreateIndex
CREATE UNIQUE INDEX "connections_user_id_connector_id_external_account_id_key" ON "connections"("user_id", "connector_id", "external_account_id");

-- CreateIndex
CREATE INDEX "idx_zap_steps_zap_id" ON "zap_steps"("zap_id");

-- CreateIndex
CREATE UNIQUE INDEX "zap_steps_zap_id_position_key" ON "zap_steps"("zap_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_event_id_zap_id_key" ON "webhook_events"("event_id", "zap_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_webhook_event_id_key" ON "outbox"("webhook_event_id");

-- CreateIndex
CREATE INDEX "idx_outbox_status_created" ON "outbox"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "zap_runs_webhook_event_id_key" ON "zap_runs"("webhook_event_id");

-- CreateIndex
CREATE INDEX "idx_zap_runs_zap_status" ON "zap_runs"("zap_id", "status");

-- CreateIndex
CREATE INDEX "idx_zap_run_steps_zap_run_id" ON "zap_run_steps"("zap_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "zap_run_steps_zap_run_id_zap_step_id_key" ON "zap_run_steps"("zap_run_id", "zap_step_id");

-- AddForeignKey
ALTER TABLE "available_triggers" ADD CONSTRAINT "available_triggers_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "available_actions" ADD CONSTRAINT "available_actions_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zaps" ADD CONSTRAINT "zaps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zap_steps" ADD CONSTRAINT "zap_steps_zap_id_fkey" FOREIGN KEY ("zap_id") REFERENCES "zaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zap_steps" ADD CONSTRAINT "zap_steps_available_trigger_id_fkey" FOREIGN KEY ("available_trigger_id") REFERENCES "available_triggers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zap_steps" ADD CONSTRAINT "zap_steps_available_action_id_fkey" FOREIGN KEY ("available_action_id") REFERENCES "available_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zap_steps" ADD CONSTRAINT "zap_steps_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_zap_id_fkey" FOREIGN KEY ("zap_id") REFERENCES "zaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zap_runs" ADD CONSTRAINT "zap_runs_zap_id_fkey" FOREIGN KEY ("zap_id") REFERENCES "zaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zap_runs" ADD CONSTRAINT "zap_runs_webhook_event_id_fkey" FOREIGN KEY ("webhook_event_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zap_run_steps" ADD CONSTRAINT "zap_run_steps_zap_run_id_fkey" FOREIGN KEY ("zap_run_id") REFERENCES "zap_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zap_run_steps" ADD CONSTRAINT "zap_run_steps_zap_step_id_fkey" FOREIGN KEY ("zap_step_id") REFERENCES "zap_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
