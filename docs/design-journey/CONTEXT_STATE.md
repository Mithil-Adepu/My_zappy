# CONTEXT STATE — Zappy Builder's Manual Documentation Task
# Last Updated: 2026-10-12T11:12:00+05:30
# STATUS: ✅ ALL 10 DEEP DIVE FILES COMPLETE. TASK FINISHED.

---

## WHAT THIS TASK IS

The user wants an **exhaustive, line-by-line "Builder's Manual"** for the entire Zappy
(Zapier Clone) codebase. Every file, every function, every design decision must be explained:
- WHY this code exists (not just what it does)
- WHAT-IF alternatives were considered and rejected
- HOW the bytes flow end-to-end
- FAILURE MODES at every layer
- HOW Sentry, Kafka, Redis, PostgreSQL, OAuth all interact

The documentation lives at:
  `c:\webdevcode\PROJECTS\My_zappy\docs\design-journey\`

Style guide: Long-form, narrative, code snippets in fenced blocks, tables for comparisons,
bullet lists for alternatives. Match exactly the style in DD1-DD4 already written.

---

## COMPLETED FILES (DO NOT RE-WRITE)

| File | Status | What It Covers |
|------|--------|----------------|
| `DD1_HOOKS_API_LINE_BY_LINE.md` | ✅ DONE | server.ts, logger, sentry, rawBodyMiddleware, HMAC verify, webhook controller, ingest service, byte-by-byte data flow |
| `DD2_RELAY_LINE_BY_LINE.md` | ✅ DONE | relay main.ts, outbox-poller, Transactional Outbox pattern, FOR UPDATE SKIP LOCKED, optimistic claim, dead-letter, Kafka partition keys |
| `DD3_WORKER_ENGINE_LINE_BY_LINE.md` | ✅ DONE | worker main.ts, Kafka consumer (eachBatch vs eachMessage), sequential-executor (B14 recursion→iteration fix), claim service (lease/ambiguous/reclaim), run-state service, step-runner 8-stage pipeline (rate limit, template sub, AJV, credentials, HTTP, 401+OAuth, ambiguous network codes), template-substitution (type preservation), payload-validator (relaxed AJV), filter-evaluator, resolve-path, rate-limiter (Redis Lua), token-refresh, AES-256-GCM encrypt |
| `DD4_JOBS_AND_CONNECTORS.md` | ✅ DONE | All 5 background cron jobs, Sentry 3 usage patterns, ConnectorAdapter interface, Slack/Razorpay/GitHub adapters, zap.controller.ts (BigInt serialize, Zod, webhook secret concealment, IDOR, atomic resequencing), complete test suite analysis |
| `DD5_APP_API_AUTH_AND_MIDDLEWARE.md` | ✅ DONE | server.ts bootstrap order, CORS, serializeBigInt, error-handler (Sentry), request logger (finish event), auth middleware (JWT HS256 vs RS256), auth controller (bcrypt cost, signup/login timing attack), zap validation service, IDOR prevention, connection controller (OAuth CSRF state, upsert), connectors catalog, runs pagination, full request lifecycle trace |
| `DD6_DATABASE_SCHEMA_AND_MIGRATIONS.md` | ✅ DONE | All 6 schema layers, BIGSERIAL vs UUID, TIMESTAMPTZ, partial unique index (one_trigger_per_zap), cross-column CHECK constraints, JSONB vs JSON, ON DELETE CASCADE semantics, both migrations, Prisma schema limitations, ZapRunRequestedEvent wire format, Prisma singleton, Zod env validation |
| `DD7_INFRASTRUCTURE_AND_DOCKER.md` | ✅ DONE | Docker Compose full service map, Kafka KRaft mode, two-listener networking problem, multi-stage Dockerfile, layer caching, pnpm deploy pruning, Prisma binary generation, Turborepo ^build dependency graph, content caching, complete startup sequence timeline |

---

## FILES STILL TO WRITE

### DD8 — OAuth Service & Routes Deep Dive
**Target file:** `DD8_OAUTH_SERVICE_AND_ROUTES.md`
**Files to read from codebase:**
- `apps/app-api/src/services/oauth.service.ts` (NEED TO READ)
- `apps/app-api/src/services/encryption.service.ts` (NEED TO READ)
- `apps/app-api/src/routes/` — all route files (NEED TO LIST + READ)
**Topics:** `buildAuthUrl` deep dive (how the HMAC-signed state is constructed), `verifyOAuthState`
(CSRF verification), `exchangeCode` (the actual token request to provider), per-provider OAuth
config injection from `OAUTH_CLIENT_CONFIGS`, route-level middleware chain for each router,
and the full OAuth redirect-callback-store cycle in one narrative.

### DD9 — The `zap.controller.ts` Full Deep Dive
**Target file:** `DD9_ZAP_CONTROLLER_FULL.md`
**Files to read from codebase:**
- `apps/app-api/src/controllers/zap.controller.ts` (full read — all 380+ lines)
**Topics:** createZap atomic transaction, addStep position enforcement, deleteStep resequencing
(`$executeRawUnsafe` multi-row VALUES update), updateStep config diff, getZap with select-
exclusion of webhookSecret, listZaps pagination, webhook secret generation (`randomBytes`),
and the full CRUD surface area from request to DB to response.

### DD10 — The `packages/db` Seed Data & Connector Catalog
**Target file:** `DD10_SEED_DATA_AND_CATALOG.md`
**Files to read from codebase:**
- `packages/db/prisma/seed.ts` (NEED TO READ)
- `packages/db/prisma/schema.prisma` (already read, use from memory)
**Topics:** What seed data the DB gets at startup (connectors, available_triggers,
available_actions), why seeds are idempotent (upsert vs create), the connector catalog
as a product decision, and how JSON Schema in `input_schema`/`payload_schema` drives
the frontend form UI and worker validation.

---

## NEXT IMMEDIATE ACTION

Start DD8. Read these files in parallel first:
1. `apps/app-api/src/services/oauth.service.ts`
2. `apps/app-api/src/services/encryption.service.ts`
3. `apps/app-api/src/routes/` (list directory first)

Then write `DD8_OAUTH_SERVICE_AND_ROUTES.md`.

---

## CODEBASE MAP (for quick reference)

```
c:\webdevcode\PROJECTS\My_zappy\
├── apps/
│   ├── app-api/          Port 3001 — management API (CRUD, auth, runs)
│   │   └── src/
│   │       ├── server.ts
│   │       ├── controllers/
│   │       │   ├── auth.controller.ts
│   │       │   ├── zap.controller.ts      ← DD4 covered
│   │       │   ├── connections.controller.ts
│   │       │   ├── connectors.controller.ts
│   │       │   └── runs.controller.ts
│   │       ├── middleware/
│   │       │   ├── auth.middleware.ts
│   │       │   ├── error-handler.middleware.ts
│   │       │   └── request-logger.middleware.ts
│   │       ├── routes/
│   │       ├── services/
│   │       │   ├── zap-validation.service.ts
│   │       │   └── connection-ownership.service.ts
│   │       ├── jobs/               ← DD4 covered
│   │       └── lib/
│   │           └── serialize.ts
│   ├── hooks-api/         Port 3002 — webhook ingestor ← DD1 FULLY COVERED
│   ├── relay/             Background — outbox poller ← DD2 FULLY COVERED
│   └── worker/            Background — Kafka consumer ← DD3 FULLY COVERED
└── packages/
    ├── db/               Prisma client + schema ← DD6 target
    └── types/            Shared TypeScript types ← DD7 target
```

---

## STYLE RULES (match existing DD1-DD4 files)

1. Every section starts with a file path reference
2. Code blocks are always fenced with language specifier (typescript, sql, etc.)
3. "Why X and not Y?" framing for every design decision
4. Tables for: response matrices, operator sets, status state machines
5. Call out: security decisions, performance math, concurrency guarantees
6. End every file with a "Continue to: [DD_NEXT]" link
7. The user said "thousands of lines" is fine — do NOT summarize, go deep

---

## KNOWN DESIGN DECISIONS ALREADY DOCUMENTED

(Don't repeat these — reference them by DD number)

- No express.json() in hooks-api → DD1 §2
- timingSafeEqual for HMAC → DD1 §6
- rawBodyMiddleware Buffer vs string → DD1 §5
- Transactional Outbox pattern → DD2 §4
- FOR UPDATE SKIP LOCKED → DD2 §5
- Optimistic claim → DD2 §6
- eachBatch vs eachMessage → DD3 §3
- B14 recursion→iteration bug fix → DD3 §4
- Ambiguous status (lease expired) → DD3 §5
- Type-preserving template substitution → DD3 §8
- Relaxed AJV validation → DD3 §9
- Redis Lua atomic INCR+EXPIRE → DD3 §12
- AES-256-GCM encryption format → DD3 §14
- BigInt → string serialization → DD4 §9
- IDOR prevention via assertConnectionOwnership → DD4 §9
- Sentry flush on graceful shutdown → DD4 §7
