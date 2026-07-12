# ZapFlow — Project State

> Last updated: 2026-07-12  
> Maintained by: engineering team  
> Update this file whenever architecture changes, new env vars are added, or a service is added/removed.

---

## What This Project Is

**ZapFlow** is a Zapier-clone — a sequential workflow automation engine. Users connect third-party apps via OAuth or API key, build a **Zap** (one trigger + ordered steps), and when the trigger fires a webhook, the system runs each step in strict order. No branching. No DAG. See `design.md` for the full specification.

---

## Architecture

```
Browser (Next.js :3000)  ─── deployed to Vercel
        ↕ REST (JWT)
app-api (:3001) ─── Postgres ─── hooks-api (:3002)
                        ↓                  ↓ writes outbox row
                     relay (:3003)  ←─────┘
                        ↓ Kafka (user_id partition key)
                      worker (:3004)
                        ↓ connector adapters
               Slack / Razorpay / GitHub APIs
```

---

## Services

| Service | Port | Role | Runs on |
|---------|------|------|---------|
| `web` | 3000 | Next.js frontend | Vercel (not in docker-compose) |
| `app-api` | 3001 | REST API — auth, CRUD for zaps/connections/steps, cron jobs | Railway/Render/Fly.io |
| `hooks-api` | 3002 | Webhook receiver only — HMAC verify → outbox write | Railway/Render/Fly.io |
| `relay` | 3003 | Outbox poller → Kafka producer | Railway/Render/Fly.io |
| `worker` | 3004 | Kafka consumer → sequential executor → adapters | Railway/Render/Fly.io |

## Shared Packages

| Package | Role |
|---------|------|
| `@zapier-clone/db` | Prisma client + schema + migrations + seed |
| `@zapier-clone/types` | Kafka event types, connector schema types |

---

## Data Flow

```
1. Browser → app-api      Create/configure Zap, connect apps
2. Provider → hooks-api   POST /hooks/:zapId/:stepId
3. hooks-api              HMAC verify → INSERT webhook_events + outbox (atomic tx)
4. relay                  SELECT FOR UPDATE SKIP LOCKED on outbox → Kafka produce
5. worker                 Kafka consume → claim step (ON CONFLICT DO NOTHING) → execute
6. worker                 Template substitution → connector adapter → write zapRunStep
7. worker                 Repeat for next step in position order until terminal
8. Browser → app-api      GET /runs/:zapId for run history + step timeline
```

---

## Environment Variables

### `app-api`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `REDIS_URL` | ✅ | — | Redis connection string |
| `JWT_SECRET` | ✅ | — | ≥16 char secret for JWT signing |
| `JWT_EXPIRES_IN` | — | `7d` | JWT expiry duration |
| `ENCRYPTION_KEY` | ✅ | — | 64 hex chars = 32 bytes AES key |
| `APP_API_PORT` | — | `3001` | HTTP port |
| `WEB_APP_URL` | — | `http://localhost:3000` | Web app origin (CORS + OAuth redirect) |
| `SLACK_CLIENT_ID` | — | — | Slack OAuth app client ID |
| `SLACK_CLIENT_SECRET` | — | — | Slack OAuth app client secret |
| `SLACK_REDIRECT_URI` | — | — | OAuth callback URL (must match Slack app config) |
| `SENTRY_DSN` | — | — | Sentry DSN for error reporting |
| `NODE_ENV` | — | `development` | `development` \| `production` \| `test` |

### `hooks-api`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `HOOKS_API_PORT` | — | `3002` | HTTP port |
| `SENTRY_DSN` | — | — | Sentry DSN |
| `NODE_ENV` | — | `development` | |

### `relay`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `KAFKA_BROKERS` | — | `localhost:9092` | Comma-separated broker list |
| `KAFKA_CLIENT_ID` | — | `zapier-relay` | Kafka client identifier |
| `KAFKA_TOPIC_ZAP_RUN_REQUESTED` | — | `zap.run.requested` | Topic name |
| `RELAY_POLL_INTERVAL_MS` | — | `2000` | Outbox poll frequency |
| `RELAY_BATCH_SIZE` | — | `50` | Rows per poll sweep |
| `RELAY_HEALTH_PORT` | — | `3003` | Health endpoint port |
| `NODE_ENV` | — | `development` | |

### `worker`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `REDIS_URL` | ✅ | — | Redis (rate limiter) |
| `ENCRYPTION_KEY` | ✅ | — | Same 64 hex char key as app-api |
| `KAFKA_BROKERS` | — | `localhost:9092` | |
| `KAFKA_CLIENT_ID` | — | `zapier-worker` | |
| `KAFKA_GROUP_ID_WORKER` | — | `zapier-worker` | Consumer group |
| `KAFKA_TOPIC_ZAP_RUN_REQUESTED` | — | `zap.run.requested` | |
| `WORKER_LEASE_TIMEOUT_MS` | — | `120000` | Step lease TTL (ms) |
| `WORKER_RATE_LIMIT_PER_CONNECTION` | — | `100` | Max requests per window per connection |
| `WORKER_RATE_LIMIT_WINDOW_SECONDS` | — | `60` | Rate limit window (seconds) |
| `WORKER_HEALTH_PORT` | — | `3004` | Health endpoint port |
| `NODE_ENV` | — | `development` | |

### `web`

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | ✅ | app-api base URL (e.g. `http://localhost:3001`) |
| `NEXT_PUBLIC_HOOKS_URL` | ✅ | hooks-api base URL (shown in UI webhook setup instructions) |

---

## How to Run Locally

### Prerequisites
- Docker + Docker Compose
- pnpm ≥ 8
- Node.js ≥ 20

### Steps

```bash
# 1. Install all dependencies
pnpm install

# 2. Copy env file and fill in values
cp .env.example .env

# 3. Start Postgres, Redis, Kafka
make infra-up

# 4. Run Prisma migrations + seed connectors
make db-migrate
make db-seed

# 5. Start all 4 backend services in parallel
make dev

# 6. Start Next.js frontend (separate terminal)
cd apps/web && pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### Send a Test Webhook

```bash
# Get your zap's stepId from the /dashboard after creating a Zap with Razorpay trigger
ZAP_ID=1
STEP_ID=1
SECRET=your_webhook_secret_here

# Compute signature
PAYLOAD='{"event":"payment.captured","payload":{"payment":{"entity":{"amount":10000,"currency":"INR"}}}}'
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

curl -X POST http://localhost:3002/hooks/$ZAP_ID/$STEP_ID \
  -H "Content-Type: application/json" \
  -H "X-Razorpay-Signature: $SIG" \
  -d "$PAYLOAD"
```

---

## Connector Catalog

| Connector | Auth | Triggers | Actions |
|-----------|------|---------|------|
| Razorpay | API Key | `payment.captured` | `create-payment` |
| Slack | OAuth | — | `send-message` |
| GitHub | API Key (PAT) | `push`, `pull_request_opened`, `issue_opened`, `branch_created`, `release_published` | `create-issue` |
| Webhooks by ZapFlow | API Key (secret) | `catch_hook` (any webhook) | — |

### GitHub Trigger — Event Routing

Hooks-api reads the `X-GitHub-Event` header and matches it to the step's `availableTriggerId`:

| Trigger ID | Requires header | Action filter |
|---|---|---|
| `github:push` | `X-GitHub-Event: push` | — |
| `github:pull_request_opened` | `X-GitHub-Event: pull_request` | `action: opened` |
| `github:issue_opened` | `X-GitHub-Event: issues` | `action: opened` |
| `github:branch_created` | `X-GitHub-Event: create` | `ref_type: branch` |
| `github:release_published` | `X-GitHub-Event: release` | `action: published` |
| `webhooks:catch_hook` | any / none | — (pass-through) |

Deliveries where event type or action doesn't match return `200 OK` silently (status: `skipped`) — GitHub does not retry them.

---

## Known Limitations

- No admin UI for manually reviewing `ambiguous` run steps (stuck from lease expiry) — deferred.
- OAuth token refresh uses a generic grant flow — provider-specific client credentials must be stored separately.
- GitHub as a trigger requires configuring one webhook URL per Zap in GitHub’s repository settings.
