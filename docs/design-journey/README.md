# ZapFlow — Complete Engineering & Design Journey

> **The Definitive Architecture Bible, Builder's Manual & Code Walkthrough**  
> *Everything you ever wanted to know about how this Zapier Clone was conceived, architected, debugged, and shipped.*

---

## 📚 Table of Contents & Chapter Guide

This documentation suite is organized into 10 exhaustive, deeply technical chapters located in `docs/design-journey/`:

| # | Chapter Title | Core Topics Covered |
|---|:---|:---|
| **01** | [**Philosophy, Core Concepts & The Webhook Problem**](./01_PHILOSOPHY_AND_CORE_CONCEPTS.md) | What Zapier actually is ("When X happens, do Y"), Cross-domain translation across isolated servers, Polling vs. Webhook push architecture (the 99% waste problem, cursor state, rate limits), The fallacy of naive webhook handlers, The 5 Golden Rules of Ingestion, Strict linear pipelines vs. DAGs. |
| **02** | [**High-Level Architecture & End-to-End Data Flow**](./02_HIGH_LEVEL_ARCHITECTURE_AND_DATA_FLOW.md) | Monorepo layout (`pnpm` + Turborepo), The 5 decoupled services (`web`, `app-api`, `hooks-api`, `relay`, `worker`), The 2 shared packages (`@zapier-clone/db`, `@zapier-clone/types`), End-to-end event lifecycle trace, Mermaid sequence and system architecture diagrams, Alternative designs rejected. |
| **03** | [**Database Schema & Relational Design**](./03_DATABASE_SCHEMA_AND_RELATIONAL_DESIGN.md) | The 6-layer relational topology, PostgreSQL schema analysis (`users`, `connectors`, `connections`, `zaps`, `zap_steps`, `webhook_events`, `outbox`, `zap_runs`, `zap_run_steps`), PostgreSQL partial unique indexes (`one_trigger_per_zap`), CHECK constraints, AES-256-GCM token encryption, Cross-row connection ownership boundary (`assertConnectionOwnership`). |
| **04** | [**Ingestion Engine & Cryptographic Security (`hooks-api`)**](./04_INGESTION_AND_SECURITY_HOOKS_API.md) | Ingress architecture on Port 3002, Raw body streaming buffer vs. `express.json()` byte alteration, HMAC-SHA256 constant-time verification (`crypto.timingSafeEqual`) and timing attack mathematics, Multi-vendor headers, Non-numeric ID guards, Information leakage prevention (returning 200 on `not_found`), GitHub trigger routing table, The atomic 3-way ingestion transaction. |
| **05** | [**The Transactional Outbox Pattern & Relay Daemon**](./05_THE_TRANSACTIONAL_OUTBOX_AND_RELAY.md) | The Dual-Write Problem and why 2PC is impossible, The Transactional Outbox Pattern mechanics, `relay` daemon deep dive, Concurrency without locking via `SELECT ... FOR UPDATE OF o SKIP LOCKED`, The Optimistic Claim pattern, Producing to Kafka outside SQL transactions, Tenant blast radius isolation via `user_id` partition keys, Graceful shutdown handling (`SIGTERM`). |
| **06** | [**Execution Engine & Worker Core (`apps/worker`)**](./06_EXECUTION_ENGINE_AND_WORKER_CORE.md) | Worker architecture on Port 3004, Kafka consumer session timeout prevention via `eachBatch` + manual heartbeat, Runtime step snapshot freezing, Sequential executor loop, Fixing Bug B14 (Recursion to Iteration), Resuming interrupted runs, 8-stage step runner pipeline, Native type preservation in template substitution, Relaxed AJV schema validation, Lazy OAuth 401 refresh, Ambiguous network timeout classification. |
| **07** | [**Distributed Safety, Concurrency & Resilience**](./07_DISTRIBUTED_SAFETY_CONCURRENCY_AND_RESILIENCE.md) | Distributed step claiming (`INSERT ON CONFLICT DO NOTHING`), Worker lease timeouts (`WORKER_LEASE_TIMEOUT_MS = 120000`), The ambiguous-outcome dilemma on expired leases, Sliding-window token bucket in Redis via atomic Lua `ATOMIC_INCR_EXPIRE`, Backpressure without failure, Suite of 5 self-healing background cron jobs (`retryStuckSteps`, `recoverDispatchedOutbox`, `stuckOutboxAlert`, `refreshExpiringTokens`, `outboxCleanup`). |
| **08** | [**Management API, Auth & Frontend Integration**](./08_APP_API_AUTHENTICATION_AND_FRONTEND_INTEGRATION.md) | `app-api` architecture on Port 3001, JavaScript `BigInt` serialization crash and `serializeBigInt` solution, Stateless JWT verification, Step contiguity and validation rules, Webhook secret concealment pattern, Atomic step position resequencing via PostgreSQL `UPDATE ... FROM (VALUES ...)`, Next.js 14 frontend integration and visual execution timeline. |
| **09** | [**The Connector Catalog & Extensibility Engine**](./09_CONNECTOR_CATALOG_AND_EXTENSIBILITY.md) | The unified `ConnectorAdapter` interface (`buildRequest`, `parseResponse`), Deep dives into Slack (`chat.postMessage`, OAuth CSRF state signing), Razorpay (`Basic Auth`, `X-Idempotency-Key`), and GitHub (`create-issue`, REST API v3), Generic webhook catch-hook trigger, The 4-step recipe for adding new third-party connectors. |
| **10** | [**Comprehensive Code Walkthrough & Reference Map**](./10_COMPREHENSIVE_CODE_WALKTHROUGH_AND_INDEX.md) | Complete file-to-function responsibility mind map, Exhaustive breakdown of every single file, class, middleware, controller, service, job, and model across the entire monorepo, End-to-end integration test trace (`pipeline.e2e.test.ts`). |

---

## 🚀 Quick Architectural Summary

```
[External Webhook]
       │
       ▼
1. hooks-api (:3002) ──► Raw Body Buffer ──► HMAC Verify ──► Atomic DB Insert
                                                                    │
       ┌────────────────────────────────────────────────────────────┘
       ▼
2. PostgreSQL (Postgres 16)
   - webhook_events (Deduplication via UNIQUE event_id, zap_id)
   - zap_runs (Initial state: queued)
   - outbox (State: pending)
       │
       ▼
3. relay (:3003) ──► SELECT ... FOR UPDATE OF outbox SKIP LOCKED
   - Updates outbox status = 'dispatched'
   - Produces message to Kafka topic: zap.run.requested (Key = user_id)
       │
       ▼
4. Apache Kafka (KRaft mode)
       │
       ▼
5. worker (:3004) ──► Consumer Group (eachBatch + heartbeat)
   - Claims run: status = 'in_progress', freezes step_snapshot
   - Updates outbox status = 'consumed'
   - Sequential Executor (Iterative while-loop):
       * Rate Check: Redis Token Bucket (Atomic Lua INCR+EXPIRE)
       * Step 0: Trigger output aliased to step_1
       * Step 1: Filter evaluation (AND / OR) -> halts if false
       * Step 2+: Action execution via ConnectorAdapter
       * AES-256-GCM Credential Decryption
       * Lazy OAuth Refresh on HTTP 401
       * Writes zap_run_steps result
   - Transitions zap_runs status = 'completed' (or 'failed')
       │
       ▼
6. app-api (:3001) & web (:3000)
   - User views live step timeline and execution outputs on /dashboard/zaps/[id]/runs
```

---

## 🛠️ Key Technology Stack

- **Runtime & Language:** Node.js 20+, TypeScript 5 (Strict Mode), ES2022.
- **Monorepo Management:** `pnpm` workspaces, Turborepo.
- **Database & ORM:** PostgreSQL 16, Prisma 5, Raw SQL migrations with `pgcrypto`.
- **Message Broker:** Apache Kafka (KRaft mode) via `kafkajs`.
- **Distributed Cache & Rate Limiting:** Redis 7 via `ioredis` with custom Lua scripts.
- **Frontend Framework:** Next.js 14 (App Router), React, Tailwind CSS.
- **Testing:** Vitest, Docker Compose test environments.
- **Observability:** Sentry Node SDK, structured JSON logging via Pino.
