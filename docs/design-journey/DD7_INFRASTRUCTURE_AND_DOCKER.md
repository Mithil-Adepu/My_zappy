# Deep Dive 7 — Docker Compose, Turborepo & Local Development Infrastructure: Every Line Explained

> This chapter explains the entire infrastructure stack: why Kafka runs in KRaft mode (no
> ZooKeeper), the two-listener Kafka networking problem, the multi-stage Docker build pattern,
> why `pnpm deploy` exists, why Prisma generates at Docker build time, health check strategies
> per service, `depends_on: condition: service_healthy` ordering, the Turborepo task graph
> with `^build` dependency notation, and the startup sequence that brings the entire system to life.

---

## Table of Contents

1. [The Full Service Map — 8 Containers](#1-the-full-service-map--8-containers)
2. [`postgres` — Configuration, Volume, and Health Check](#2-postgres--configuration-volume-and-health-check)
3. [`redis` — Single Instance Rate Limiter](#3-redis--single-instance-rate-limiter)
4. [`kafka` — KRaft Mode and the Two-Listener Problem](#4-kafka--kraft-mode-and-the-two-listener-problem)
5. [`kafka-init` — One-Shot Topic Creation](#5-kafka-init--one-shot-topic-creation)
6. [`app-api` — Migration Runner + Server](#6-app-api--migration-runner--server)
7. [`hooks-api`, `relay`, `worker` — Service Configs](#7-hooks-api-relay-worker--service-configs)
8. [`web` — The Next.js Frontend Container](#8-web--the-nextjs-frontend-container)
9. [The Multi-Stage Dockerfile — Builder/Runner Pattern](#9-the-multi-stage-dockerfile--builderrunner-pattern)
10. [The `pnpm deploy` Command — Production Pruning](#10-the-pnpm-deploy-command--production-pruning)
11. [Turborepo Task Graph — `^build` and Caching](#11-turborepo-task-graph--build-and-caching)
12. [The Complete Startup Sequence](#12-the-complete-startup-sequence)
13. [Environment Variable Architecture — `.env` vs Override](#13-environment-variable-architecture--env-vs-override)

---

## 1. The Full Service Map — 8 Containers

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Docker Compose Network                          │
│                                                                          │
│  Infrastructure                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────────────────┐  │
│  │ postgres │    │  redis   │    │              kafka                │  │
│  │ :5432    │    │ :6379    │    │ INTERNAL:9092 / EXTERNAL:9093     │  │
│  └──────────┘    └──────────┘    └──────────────────────────────────┘  │
│                                                                          │
│  One-shot                                                                │
│  ┌────────────────────────────┐                                         │
│  │        kafka-init          │  Creates 'zap.run.requested' topic      │
│  │       (runs once)          │                                         │
│  └────────────────────────────┘                                         │
│                                                                          │
│  Application Services                                                    │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│  │ app-api  │    │hooks-api │    │  relay   │    │  worker  │         │
│  │ :3001    │    │ :3002    │    │ :3003    │    │ :3004    │         │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘         │
│                                                                          │
│  Frontend                                                                │
│  ┌──────────────────────────────────┐                                   │
│  │               web                │                                   │
│  │             :3000                │                                   │
│  └──────────────────────────────────┘                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

All containers join the default Docker Compose bridge network automatically. Container names
(`zapier_postgres`, `zapier_kafka`) are the DNS hostnames used for inter-container communication.
`kafka:9092` inside the compose network reaches the Kafka container at port 9092.

---

## 2. `postgres` — Configuration, Volume, and Health Check

```yaml
postgres:
  image: postgres:16-alpine
  container_name: zapier_postgres
  environment:
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: postgres
    POSTGRES_DB: zapier_clone
  ports:
    - '5433:5432'
  volumes:
    - postgres_data:/var/lib/postgresql/data
  healthcheck:
    test: ['CMD-SHELL', 'pg_isready -U postgres']
    interval: 5s
    timeout: 5s
    retries: 10
```

### Port mapping: `5433:5432`

**Format: `HOST_PORT:CONTAINER_PORT`.** PostgreSQL runs on port 5432 inside the container. We
map it to host port 5433 (not 5432) to avoid conflict with a local PostgreSQL installation that
might already be running on 5432. With this mapping:

- Inside Docker network: `postgres:5432` (container-to-container)
- From host machine: `localhost:5433` (developer's DB client, migrations run from host)

The application containers use `DATABASE_URL: postgresql://postgres:postgres@postgres:5432/...`
(container port 5432, hostname `postgres`). The `.env` file for local dev (run from host) uses
`DATABASE_URL: postgresql://localhost:5433/...` (host port 5433).

### `postgres:16-alpine` image

**Why Alpine?** Alpine Linux images are 5-10× smaller than Debian-based images. `postgres:16`
(Debian) is ~400MB; `postgres:16-alpine` is ~80MB. Smaller images mean faster pulls in CI/CD
and less disk usage in production.

**Why PostgreSQL 16?** Version 16 (released Sept 2023) added improved logical replication and
query parallelism. More practically: it's the latest stable version at the time of the project,
ensuring security patches. When choosing a base image, always use a specific major version
(`16`, not `latest`) — `latest` can break your build when a new major version is released.

### Named volume: `postgres_data`

```yaml
volumes:
  - postgres_data:/var/lib/postgresql/data
```

A named volume (`postgres_data`) is managed by Docker. PostgreSQL stores its data files at
`/var/lib/postgresql/data` inside the container. Without this volume mount:
- All data is stored in the container's writable layer
- `docker compose down` destroys the container AND its data
- Every restart starts with an empty database

With the named volume:
- Data persists across `docker compose down / up` cycles
- `docker compose down -v` explicitly destroys the volume (for a fresh database)
- `docker volume ls` shows all named volumes

### Health check: `pg_isready`

```yaml
healthcheck:
  test: ['CMD-SHELL', 'pg_isready -U postgres']
  interval: 5s
  timeout: 5s
  retries: 10
```

`pg_isready` is PostgreSQL's built-in readiness probe. It connects to the DB and checks if
it's accepting connections. Returns exit code 0 (healthy) or non-zero (not ready).

**`interval: 5s, retries: 10`** — Docker checks every 5 seconds. After 10 consecutive failures
(50 seconds total), the container is marked unhealthy. Services with `depends_on:
condition: service_healthy` won't start until this health check passes.

**Why health checks matter:** Without health checks, Docker Compose starts containers in the
`depends_on` order but doesn't wait for them to be fully ready. `app-api` might start and try
to connect to Postgres 2 seconds after Postgres starts — but Postgres takes 5-10 seconds to
initialize (WAL setup, recovery). Without health checks, `app-api` would fail with
"connection refused" and never recover.

---

## 3. `redis` — Single Instance Rate Limiter

```yaml
redis:
  image: redis:7-alpine
  container_name: zapier_redis
  ports:
    - '6379:6379'
  healthcheck:
    test: ['CMD', 'redis-cli', 'ping']
    interval: 5s
    timeout: 5s
    retries: 10
```

**No persistence configuration.** Redis defaults to in-memory storage with no AOF (Append-Only
File) or RDB (snapshot) persistence. If Redis restarts:
- Rate limit counters reset to zero (all connections start fresh windows)
- Run caps reset to zero (all zaps start fresh hourly buckets)

**Is this acceptable?** Yes. Rate limit data is ephemeral by design. A Redis restart means the
rate limiting window resets, which might allow a brief burst of requests. This is a
business-acceptable trade-off for operational simplicity. If Redis persistence is needed (e.g.,
for run cap enforcement that must survive restart), add `command: redis-server --appendonly yes`.

**`redis-cli ping`** — the health check sends a `PING` command and expects `PONG`. This is
Redis's built-in liveness check. Unlike Postgres's `pg_isready` (which checks TCP AND
authentication), Redis's PING is unauthenticated by default — correct if you're using Redis
without password auth.

**Single instance** — no Redis Cluster, no Replication. In production with multiple worker
instances, the Lua scripts in `rate-limiter.service.ts` rely on single-node atomicity. Redis
Cluster does NOT guarantee that `EVAL` (Lua scripts) execute atomically across cluster nodes.
If multiple worker instances are deployed, all must point to the SAME Redis instance (or use
Redis Cluster Lua script constraints). For Zappy's scale, a single Redis instance with
sufficient memory is the correct deployment model.

---

## 4. `kafka` — KRaft Mode and the Two-Listener Problem

```yaml
kafka:
  image: apache/kafka:3.7.0
  container_name: zapier_kafka
  environment:
    KAFKA_NODE_ID: 1
    KAFKA_PROCESS_ROLES: broker,controller
    KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9094
    KAFKA_LISTENERS: INTERNAL://:9092,EXTERNAL://:9093,CONTROLLER://:9094
    KAFKA_ADVERTISED_LISTENERS: INTERNAL://kafka:9092,EXTERNAL://localhost:9093
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT
    KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true'
    KAFKA_NUM_PARTITIONS: 4
    KAFKA_DEFAULT_REPLICATION_FACTOR: 1
```

### KRaft Mode — No ZooKeeper

Traditional Kafka (pre-3.3) required a separate ZooKeeper cluster to manage broker metadata,
leader election, and cluster coordination. This meant deploying 3-5 additional ZooKeeper nodes
alongside Kafka nodes — significant operational overhead.

**KRaft (Kafka Raft)** is the native metadata management mode introduced in Kafka 3.x. The Kafka
broker itself handles consensus and metadata using the Raft algorithm. No ZooKeeper needed.

The KRaft configuration:
```yaml
KAFKA_PROCESS_ROLES: broker,controller
```
This single node acts as BOTH a broker (handles producer/consumer connections) AND a controller
(handles cluster metadata, leader election). In a multi-node production cluster, these roles
are typically separate (dedicated controller nodes). For local dev with one node, combining both
is fine.

```yaml
KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9094
```
Tells Kafka which nodes are eligible to be controllers. Format: `nodeId@host:port`. Node 1 is
at `kafka:9094`. For a 3-node cluster, this would be `1@kafka1:9094,2@kafka2:9094,3@kafka3:9094`.

### The Two-Listener Problem

This is the most subtle networking issue in the entire Docker Compose setup, and it affects
every Kafka-in-Docker deployment.

**Background:** When a Kafka client (relay, worker) connects, it first connects to a broker
address to fetch metadata. The metadata response includes the "advertised listeners" — the
addresses clients should use for actual produce/consume operations. If the advertised address
is wrong, the client connects to metadata but then fails to connect for actual data.

**The two networking contexts:**

1. **Docker-internal (relay, worker containers):** Use container DNS names. `kafka:9092` resolves
   to the Kafka container's IP inside the Docker bridge network.

2. **Host machine (developer's local tools like `kafka-topics.sh`, E2E tests run from host):**
   Docker container DNS names don't resolve on the host. `kafka:9092` means nothing to the
   host machine. Must use `localhost:9093` (the exposed host port).

**Why one listener doesn't work:**

If you configure only `INTERNAL://kafka:9092`:
- Docker containers: ✅ `kafka:9092` resolves correctly
- Host machine: ❌ `kafka` doesn't resolve → connection fails

If you configure only `EXTERNAL://localhost:9093`:
- Host machine: ✅ `localhost:9093` works
- Docker containers: ❌ relay connects to `localhost:9093` → connects to the relay container's
  own localhost (port 9093 not open) → connection fails

**The solution — two listeners:**
```yaml
KAFKA_LISTENERS: INTERNAL://:9092,EXTERNAL://:9093,CONTROLLER://:9094
KAFKA_ADVERTISED_LISTENERS: INTERNAL://kafka:9092,EXTERNAL://localhost:9093
```

- `INTERNAL://kafka:9092` — advertised to Docker-internal clients (relay, worker set
  `KAFKA_BROKERS: kafka:9092`)
- `EXTERNAL://localhost:9093` — advertised to host machine clients (E2E tests use
  `KAFKA_BROKERS: localhost:9093`)

Docker Compose maps port 9093: `'9093:9093'` (host:container), making `localhost:9093`
accessible from the host.

**`KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL`** — when brokers talk to each other (in a
multi-node cluster, leaders talk to followers for replication), they use the `INTERNAL` listener.
This prevents broker-to-broker traffic from going through the external listener.

### `KAFKA_NUM_PARTITIONS: 4`

The default number of partitions for new topics. When `kafka-init` creates the `zap.run.requested`
topic with `--partitions 4`, this matches the default.

**Why 4 partitions?** Partitions are the unit of parallelism in Kafka. With 4 partitions and 4
worker instances, each worker owns 1 partition. A worker with 1 partition handles 1/4 of all
messages in parallel with other workers. More partitions → more parallelism (but more overhead).

For a single-node development setup with one worker, 4 partitions is overkill but harmless.
In production, you'd scale to match `num_partitions = max_worker_instances`.

### `KAFKA_DEFAULT_REPLICATION_FACTOR: 1` and `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1`

Replication factor = how many broker replicas hold each partition. In production, use 3 (3
replicas for fault tolerance — can lose 2 brokers). For local dev with 1 broker, replication
factor MUST be 1 (you can't replicate to more brokers than exist).

`KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1` — the `__consumer_offsets` internal Kafka topic
(which stores committed offsets) must also have replication factor 1. Without this override,
Kafka tries to create it with the default replication factor (which might be 3 even if you only
have 1 broker), causing startup errors.

### Health check: `kafka-topics.sh --list`

```yaml
healthcheck:
  test: ['CMD-SHELL', '/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list > /dev/null 2>&1 || exit 1']
  interval: 10s
  timeout: 15s
  retries: 15
  start_period: 30s
```

**`start_period: 30s`** — Kafka takes 15-30 seconds to start in KRaft mode (it needs to format
the metadata log, elect a controller, and become ready). During `start_period`, failed health
checks don't count toward `retries`. Without `start_period`, the health check would fail
immediately after the container starts, reach 15 retries in 2.5 minutes, and the container would
be marked unhealthy before Kafka was ready.

**`kafka-topics.sh --list`** — attempts to list all topics on the broker. Succeeds (exit 0)
when Kafka is fully initialized. The `> /dev/null 2>&1` redirects both stdout and stderr to
null — we only care about the exit code, not the output.

---

## 5. `kafka-init` — One-Shot Topic Creation

```yaml
kafka-init:
  image: apache/kafka:3.7.0
  restart: 'no'
  command: >
    sh -c "
      echo 'Waiting for Kafka to be ready...' &&
      sleep 10 &&
      /opt/kafka/bin/kafka-topics.sh
        --bootstrap-server kafka:9092
        --create
        --if-not-exists
        --topic zap.run.requested
        --partitions 4
        --replication-factor 1 &&
      echo 'Topic zap.run.requested ready.'
    "
  depends_on:
    kafka:
      condition: service_healthy
```

**Why a separate container?** We could use `KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true'` (which IS
enabled) to auto-create the topic when the first message is produced. But auto-created topics
use default settings. We want to explicitly set `--partitions 4`. The `kafka-init` container
gives us control over topic creation parameters.

**`restart: 'no'`** — this is the most important field. After the topic is created, the
container exits (exit code 0). Without `restart: 'no'`, the default behavior (`restart: unless-
stopped`) would restart the container — which would try to create the topic again (hitting the
`--if-not-exists` guard harmlessly, then exit, then restart again, indefinitely). `restart: 'no'`
means "run once, exit, don't restart."

**`--if-not-exists`** — idempotent topic creation. If the topic already exists (e.g., Docker
volumes persist the Kafka log and the topic survived a restart), the command succeeds without
error. Without this flag, re-running `kafka-init` against a topic that already exists would fail.

**`sleep 10`** — even after the `kafka_healthy` health check passes, Kafka may need an extra
few seconds to fully start handling requests. The `sleep 10` is a belt-and-suspenders extra wait.
The health check ensures Kafka is up; the sleep ensures it's fully stable.

**`depends_on: kafka: condition: service_healthy`** — `kafka-init` doesn't start until Kafka's
health check passes. This is the correct way to sequence initialization containers in Docker
Compose.

---

## 6. `app-api` — Migration Runner + Server

```yaml
app-api:
  restart: unless-stopped
  env_file:
    - .env
  environment:
    DATABASE_URL: postgresql://postgres:postgres@postgres:5432/zapier_clone
    NODE_ENV: production
  command: >
    sh -c "
      node_modules/.bin/prisma migrate deploy --schema=packages/db/prisma/schema.prisma &&
      node dist/server.js
    "
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
```

### Why `app-api` runs migrations

**`prisma migrate deploy`** runs all pending migrations against the database on every start.
This is intentional — it makes `app-api` responsible for the DB schema, which is correct since:
1. `app-api` is the only service that writes to ALL tables (it creates users, zaps, connections).
2. Migrations are idempotent — `migrate deploy` on an already-migrated DB applies nothing and
   returns success.
3. Having one service own schema migration prevents migration conflicts.

**Why not run migrations in Docker Compose's `command` for each service?** Other services (relay,
worker, hooks-api) read from the DB but don't need to run migrations. If all four services ran
`migrate deploy` simultaneously on startup, there's a risk of race conditions in the migration
lock table. Let one service own migrations.

**The startup command chain:**
```
prisma migrate deploy && node dist/server.js
```

The `&&` operator means: only start `dist/server.js` if `migrate deploy` succeeds. If the
migration fails (e.g., DB is down, incompatible migration), the app exits instead of starting
with a broken schema.

### `env_file: .env` + `environment:` override

Two sources of environment variables:
1. `env_file: .env` — loads the `.env` file (JWT secrets, encryption keys, Sentry DSN, OAuth credentials)
2. `environment:` block — overrides specific values at Docker Compose level

**The override pattern:** `DATABASE_URL` is in `.env` for local development
(`DATABASE_URL=postgresql://localhost:5433/...` for running from host). Inside Docker, the
container must use `postgres:5432` (container DNS). The `environment:` block overrides
`DATABASE_URL` to the container-internal URL. The env file's value is ignored.

This pattern allows one `.env` file to work for both host-side development AND Docker deployments
by overriding only the container-specific values.

### `restart: unless-stopped`

Three restart policies:
- `no` — never restart (one-shot jobs like `kafka-init`)
- `unless-stopped` — restart on crash, unless explicitly stopped (standard for app services)
- `always` — restart even if explicitly stopped (suitable for background agents, rare)

`unless-stopped` means: if `app-api` crashes (uncaught exception, OOM), Docker restarts it.
If you run `docker compose stop app-api`, it stays stopped. This is the correct policy for
stateful services that should recover from crashes but respect manual stops.

---

## 7. `hooks-api`, `relay`, `worker` — Service Configs

### `relay` specific config

```yaml
relay:
  environment:
    KAFKA_BROKERS: kafka:9092  # Uses INTERNAL listener
  depends_on:
    postgres:
      condition: service_healthy
    kafka:
      condition: service_healthy
    # No redis dependency — relay doesn't use Redis
```

**`KAFKA_BROKERS: kafka:9092`** — the relay is inside Docker, so it uses the `INTERNAL`
listener (`kafka:9092`). The KafkaJS client connects to this broker and discovers the INTERNAL
advertised listener for all subsequent operations.

**No `redis` in `depends_on`** — relay doesn't use Redis (rate limiting is the worker's
responsibility). Listing it would add unnecessary startup ordering requirements.

### `worker` specific config

```yaml
worker:
  environment:
    KAFKA_BROKERS: kafka:9092
    REDIS_URL: redis://redis:6379
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    kafka:
      condition: service_healthy
```

The worker depends on ALL three infrastructure services — it reads from Kafka, uses Redis for
rate limiting, and writes to Postgres. All three must be healthy before the worker starts.

### Health check pattern — Node.js HTTP check

All four application services use the same health check pattern:

```yaml
healthcheck:
  test: ['CMD-SHELL', 'node -e "require(''http'').get(''http://localhost:3001/health'', r => process.exit(r.statusCode === 200 ? 0 : 1)).on(''error'', () => process.exit(1))"']
```

**Why `node -e` instead of `curl` or `wget`?** The base image is `node:20-slim`. It includes
Node.js but may not include `curl` or `wget` (slim images strip non-essential tools to reduce
image size). Using Node.js's built-in `http` module guarantees the health check works regardless
of what other tools are installed.

**The double-quoted strings (`''`):** YAML uses single quotes. Inside a single-quoted YAML
string, single quotes must be escaped as `''` (two single quotes). So `require(''http'')` in
the YAML becomes `require('http')` in the shell command.

**Logic:** Make an HTTP GET to the service's `/health` endpoint. If status code is 200, exit 0
(healthy). If status code is non-200, or if the connection fails, exit 1 (unhealthy). Docker
reads the exit code to determine container health.

---

## 8. `web` — The Next.js Frontend Container

```yaml
web:
  ports:
    - '3000:3000'
  environment:
    NEXT_PUBLIC_API_URL: http://localhost:3001
    NEXT_PUBLIC_HOOKS_URL: http://localhost:3002
  depends_on:
    app-api:
      condition: service_healthy
```

**`NEXT_PUBLIC_*` variables** — Next.js convention for variables exposed to the browser. Variables
without `NEXT_PUBLIC_` are server-side only (not embedded in the browser bundle).

**`http://localhost:3001`** — from the browser's perspective, `localhost` refers to the machine
running the browser (the developer's laptop). Docker's port mappings (`3001:3001`) make the
`app-api` container reachable at `localhost:3001` from the host machine and thus from the browser.

This is different from `app-api`'s `DATABASE_URL: postgres:5432` — which works because the DB
connection is made server-side (within Docker). Browser connections must use host-visible addresses.

**`depends_on: app-api: condition: service_healthy`** — the web container waits for `app-api`
to be healthy. This ensures that when the browser loads the frontend, the API is already accepting
requests. Without this dependency, the browser might load the app and immediately hit "connection
refused" on the first API call.

---

## 9. The Multi-Stage Dockerfile — Builder/Runner Pattern

Both `app-api` and `worker` use identical patterns. Using `app-api` as the reference:

```dockerfile
# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update -y && apt-get install -y openssl ca-certificates

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.1.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/app-api/package.json ./apps/app-api/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/app-api ./apps/app-api

RUN pnpm --filter @zapier-clone/db build
RUN pnpm --filter @zapier-clone/types build
RUN pnpm --filter @zapier-clone/app-api build

RUN pnpm --filter @zapier-clone/app-api deploy --prod /deploy
COPY packages/db/prisma /deploy/packages/db/prisma
RUN cd /deploy && ./node_modules/.bin/prisma generate --schema=packages/db/prisma/schema.prisma

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runner

RUN apt-get update -y && apt-get install -y openssl ca-certificates

WORKDIR /app

COPY --from=builder /deploy ./

EXPOSE 3001
```

### Why multi-stage?

A single-stage build would include:
- All development dependencies (`typescript`, `@types/*`, `vitest`, `ts-node`)
- Source `.ts` files
- The TypeScript compiler
- All packages in the monorepo (not just `app-api`'s dependencies)

The resulting image would be 1-2GB. By using two stages:
- **Stage 1 (builder):** Installs all deps, compiles TypeScript → `dist/`
- **Stage 2 (runner):** Copies only the compiled output and production deps (~200MB)

`COPY --from=builder /deploy ./` — the runtime image gets only `/deploy` from the builder. The
builder's intermediate layers (node_modules with devDeps, source files, TypeScript compiler) are
discarded. The final image contains only what's needed to run the app.

### `openssl ca-certificates` — why required

```dockerfile
RUN apt-get update -y && apt-get install -y openssl ca-certificates
```

**Both stages install these.** Two reasons:

1. **Prisma's query engine is a compiled Rust binary** that uses OpenSSL for database connections.
   Without `openssl`, Prisma throws "error: error reading file: certificate verify failed."

2. **`ca-certificates`** — provides root CA certificates. Without them, HTTPS requests to Slack
   (`api.slack.com`), GitHub (`api.github.com`), and Razorpay (`api.razorpay.com`) fail with
   SSL certificate verification errors (the system doesn't know what CAs to trust).

`node:20-slim` (Debian slim) strips these packages to reduce image size. We add them back
because our runtime needs them.

### `corepack enable && corepack prepare pnpm@9.1.0 --activate`

**Corepack** is Node.js's built-in package manager version manager (bundled since Node 16.9).
`corepack enable` activates it. `corepack prepare pnpm@9.1.0 --activate` installs and activates
exactly pnpm version 9.1.0.

**Why pin the pnpm version?** The `pnpm-lock.yaml` was generated with a specific pnpm version.
Different pnpm versions can produce different `node_modules` layouts or interpret the lockfile
differently. Pinning ensures the Docker build uses the same pnpm version as the developer.

### The `COPY package.json` before `COPY src` pattern

```dockerfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY apps/app-api/package.json ./apps/app-api/

RUN pnpm install --frozen-lockfile   # ← Runs here, before copying source

COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/app-api ./apps/app-api
```

**Docker layer caching:** Docker caches each layer. If a layer's input files haven't changed,
Docker reuses the cached layer output. By copying only `package.json` files before `pnpm install`,
the `pnpm install` layer is cached as long as no `package.json` or `pnpm-lock.yaml` changes. If
you only change a `.ts` source file, Docker reuses the cached `pnpm install` layer — saving 1-2
minutes per rebuild.

If we did `COPY . .` first (copying everything), any source file change would invalidate the
`pnpm install` cache.

### `--mount=type=cache` — pnpm store caching

```dockerfile
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
```

**BuildKit cache mounts** — `--mount=type=cache` mounts a persistent cache directory that
survives across Docker builds (persisted on the build host's filesystem). pnpm stores downloaded
package tarballs in `~/.local/share/pnpm/store`. With the cache mount, packages downloaded in
the first build are reused in subsequent builds — even after the install layer cache is
invalidated (e.g., when `pnpm-lock.yaml` changes).

This dramatically reduces build times when dependencies change. Without this mount, every
`pnpm-lock.yaml` change would re-download all packages from npm.

### `pnpm deploy --prod /deploy`

```dockerfile
RUN pnpm --filter @zapier-clone/app-api deploy --prod /deploy
```

**What `pnpm deploy` does:** Creates a self-contained deployment directory at `/deploy` containing:
- The package's compiled output (referenced in `package.json`'s `main` field)
- Only production dependencies (not devDependencies)
- No other monorepo packages (just the ones this package depends on)

**Without `pnpm deploy`:** The entire monorepo `node_modules` would need to be copied to the
runtime image — including `@zapier-clone/relay`, `@zapier-clone/worker`, `vitest`, `typescript`
etc. With `pnpm deploy`, we get only `app-api`'s production dependencies: Express, Prisma client,
KafkaJS, etc.

### Prisma generate in the build stage

```dockerfile
RUN pnpm --filter @zapier-clone/app-api deploy --prod /deploy
COPY packages/db/prisma /deploy/packages/db/prisma
RUN cd /deploy && ./node_modules/.bin/prisma generate --schema=packages/db/prisma/schema.prisma
```

**Why run `prisma generate` in the Dockerfile?** `pnpm deploy --prod` doesn't include the
Prisma query engine binaries (they're generated artifacts, not source files). Without
`prisma generate`, the deployed app would fail with "Prisma Client did not initialize" at startup.

**Why after `pnpm deploy`?** `prisma generate` reads `schema.prisma` and generates the client
into `node_modules/@prisma/client`. This must happen in the `/deploy` directory (where the
runtime app's `node_modules` lives), not in the builder's root.

**Why copy the `prisma` directory?** `pnpm deploy` copies source packages but not the
`packages/db/prisma` directory (it's not a package in itself). We manually copy it so
`prisma generate --schema=packages/db/prisma/schema.prisma` can find the schema.

**The `binaryTargets` in schema.prisma:** `["native", "linux-musl-openssl-3.0.x", ...]` — when
the build runs on a Mac (native = macOS binary), it also generates the linux-musl binary for the
Docker runtime. Without multiple binary targets, the Mac-built binary would fail in the
Linux container.

---

## 10. The `pnpm deploy` Command — Production Pruning

The `pnpm deploy` pattern is the key to keeping production images lean in a monorepo. Here's
what happens step by step:

```
1. pnpm --filter @zapier-clone/app-api deploy --prod /deploy
   ├── Reads app-api's package.json
   ├── Identifies all production dependencies (not devDependencies)
   ├── Copies app-api's built output (dist/)
   ├── Copies only the production node_modules to /deploy/node_modules
   └── Does NOT copy other monorepo packages (relay, worker, etc.)

2. /deploy/ structure:
   ├── dist/               ← compiled TypeScript
   ├── node_modules/       ← production deps only
   │   ├── express/
   │   ├── @prisma/client/
   │   ├── kafkajs/
   │   └── ... (no vitest, no typescript, no @zapier-clone/relay)
   └── package.json
```

**Space savings example:**
- Full `node_modules` (all deps): ~800MB
- After `pnpm deploy --prod`: ~200MB

The 600MB savings comes from eliminating:
- TypeScript compiler (`typescript` package): ~60MB
- Vitest + dependencies: ~40MB
- ESLint + plugins: ~30MB
- All other workspace packages: ~400MB

---

## 11. Turborepo Task Graph — `^build` and Caching

**File:** `turbo.json`

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/", ".next/"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "db:seed": {
      "cache": false,
      "dependsOn": ["db:migrate"]
    }
  }
}
```

### `^build` — the upstream dependency notation

`"dependsOn": ["^build"]` means: before running this package's `build` task, first run `build`
in ALL packages this package depends on.

**Example:** `app-api` depends on `@zapier-clone/db` and `@zapier-clone/types`. When you run
`turbo build --filter @zapier-clone/app-api`:
1. Turbo reads `app-api`'s `package.json` dependencies
2. Sees `@zapier-clone/db` and `@zapier-clone/types` are local workspace packages
3. Runs `@zapier-clone/db build` and `@zapier-clone/types build` FIRST
4. Then runs `@zapier-clone/app-api build`

Without `^build`, if you changed `packages/db` and ran `turbo build --filter app-api`, Turbo
would build `app-api` with the OLD compiled `db` package. `^build` ensures the dependency graph
is always built in the correct topological order.

### Content-based caching with `outputs`

```json
"outputs": ["dist/", ".next/"]
```

Turbo caches build outputs based on input file hashes. If `app-api`'s source files haven't
changed since the last build, Turbo restores `dist/` from cache instead of recompiling.

**`outputs` is critical for cache correctness.** Without specifying outputs, Turbo doesn't know
what to cache and restore. With `["dist/", ".next/"]`, Turbo:
1. Before build: hashes all input files (source files, `package.json`, env vars)
2. After build: saves `dist/` to the cache store
3. Next build: if input hash matches → restore `dist/` from cache, skip compilation

**Cache stores:** By default, local filesystem cache (`~/.turbo`). With Turborepo Remote Cache
(Vercel or self-hosted), the cache is shared across the team — if your colleague already built
the same commit, you get their cached output instantly.

### `"cache": false` — when to disable caching

```json
"dev": {
  "cache": false,
  "persistent": true
}
```

`dev` runs the TypeScript compiler in watch mode (`ts-node --watch` or `tsc --watch`). It never
terminates (it watches for file changes). Caching a watch-mode process makes no sense — every
run is different. `cache: false` disables caching for this task.

`"persistent": true` — tells Turbo this task runs indefinitely (a server or watcher). Turbo
shows the process in a special "persistent" panel and doesn't treat it as "done."

```json
"db:seed": {
  "cache": false,
  "dependsOn": ["db:migrate"]
}
```

`db:migrate` runs Prisma migrations. `db:seed` seeds the database with connector catalog data
(Slack, GitHub, Razorpay entries). Seeds run AFTER migrations. `cache: false` because DB state
is external — Turbo can't know if the DB needs re-seeding from file hashes alone.

---

## 12. The Complete Startup Sequence

When `docker compose up` is run, Docker starts containers in dependency order. Here's the exact
sequence with timing:

```
T+0s    Docker creates the compose network
        Starts all containers simultaneously, but:

T+0s    ┌── postgres starts    → initializing WAL, data dirs
T+0s    ├── redis starts       → starting in-memory store
T+0s    └── kafka starts       → initializing KRaft metadata log, electing controller

T+15s   postgres health check passes (pg_isready succeeds)
        redis health check passes (redis-cli ping succeeds)
        → kafka-init starts (depends_on postgres is NOT required for kafka-init)

T+30s   kafka health check passes (kafka-topics.sh --list succeeds)
        → kafka-init proceeds past its health wait
        
T+40s   kafka-init: sleep 10 completes
        → kafka-init: kafka-topics.sh --create zap.run.requested
        → kafka-init exits (restart: no)

T+15s   (concurrent with above)
        → app-api starts (postgres ✅, redis ✅)
        → hooks-api starts (postgres ✅)

T+20s   app-api: prisma migrate deploy completes
        → app-api: node dist/server.js starts
        → app-api health check starts

T+30s   app-api health check passes (http://localhost:3001/health returns 200)
        → web starts (depends_on: app-api: service_healthy)

T+30s   (concurrent)
        relay starts (postgres ✅, kafka ✅)
        worker starts (postgres ✅, redis ✅, kafka ✅)

T+45s   All services healthy and running ✅
```

**Key insight: app-api runs migrations before any other service that might need the schema.**
relay and worker depend only on Kafka/Postgres being healthy (port up), not on the schema being
migrated. In practice, by the time relay and worker start (T+30s), `app-api` has already run
migrations (T+20s). The ordering works out in practice.

---

## 13. Environment Variable Architecture — `.env` vs Override

**The `.env` file** contains sensitive values that should NOT be in `docker-compose.yml`:
```
# .env (not committed to git — in .gitignore)
JWT_SECRET=super-secret-32-char-minimum-string-here
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
SENTRY_DSN=https://xxx@sentry.io/xxx
OAUTH_CLIENT_CONFIGS={"slack":{"clientId":"...","clientSecret":"..."},...}
```

**`docker-compose.yml` `environment:` blocks** contain non-sensitive service-specific overrides:
```yaml
environment:
  DATABASE_URL: postgresql://postgres:postgres@postgres:5432/zapier_clone  # Container-internal URL
  KAFKA_BROKERS: kafka:9092   # Container-internal Kafka hostname
  NODE_ENV: production
```

**`.env.example` (committed to git)** shows all required variables without their values:
```
JWT_SECRET=
ENCRYPTION_KEY=
SENTRY_DSN=
OAUTH_CLIENT_CONFIGS=
WEB_APP_URL=http://localhost:3000
```

A new developer:
1. Clones the repo
2. Copies `.env.example` to `.env`
3. Fills in the actual values
4. Runs `docker compose up`

**Merge precedence:** When both `env_file` and `environment:` set the same key, `environment:`
takes precedence. This is how `DATABASE_URL` in `.env` (pointing to `localhost:5433`) is
overridden by `DATABASE_URL` in `environment:` (pointing to `postgres:5432`).

---

*This concludes the Zappy Builder's Manual. The full documentation series:*

| File | Covers |
|------|--------|
| [DD1](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD1_HOOKS_API_LINE_BY_LINE.md) | hooks-api: HMAC, raw body, ingest |
| [DD2](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD2_RELAY_LINE_BY_LINE.md) | relay: outbox, SKIP LOCKED, Kafka produce |
| [DD3](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD3_WORKER_ENGINE_LINE_BY_LINE.md) | worker: sequential executor, step runner, OAuth |
| [DD4](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD4_JOBS_AND_CONNECTORS.md) | cron jobs, Sentry, adapters, test suite |
| [DD5](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD5_APP_API_AUTH_AND_MIDDLEWARE.md) | app-api: auth, middleware, connections, runs |
| [DD6](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD6_DATABASE_SCHEMA_AND_MIGRATIONS.md) | DB schema, migrations, shared types, Prisma |
| [DD7](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD7_INFRASTRUCTURE_AND_DOCKER.md) | Docker Compose, Kafka KRaft, Turborepo |
