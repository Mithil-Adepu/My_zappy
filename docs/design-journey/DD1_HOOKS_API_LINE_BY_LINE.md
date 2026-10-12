# Deep Dive 1 — `hooks-api`: Every Line Explained

> **This is the builder's manual you asked for.** Every file, every function, every line of
> `apps/hooks-api` is dissected here — not just what it does, but *why*, what the alternatives
> were, what goes wrong if you change it, and exactly how the bytes flow across the wire.

---

## Table of Contents

1. [The Service in One Paragraph](#1-the-service-in-one-paragraph)
2. [`server.ts` — The Express Bootstrap](#2-serverts--the-express-bootstrap)
3. [`lib/logger.ts` — Structured Logging](#3-libloggerts--structured-logging)
4. [`lib/sentry.ts` — Error Monitoring](#4-libsentryts--error-monitoring)
5. [`middleware/raw-body.middleware.ts` — Byte-Level Body Capture](#5-middlewareraw-bodymiddlewarets--byte-level-body-capture)
6. [`services/hmac-verify.service.ts` — Cryptographic Signature Verification](#6-serviceshmac-verifyservicets--cryptographic-signature-verification)
7. [`controllers/webhook.controller.ts` — The HTTP Orchestrator](#7-controllerswebhookcontrollerts--the-http-orchestrator)
8. [`services/webhook-ingest.service.ts` — The Core Ingest Logic](#8-serviceswebhook-ingestservicets--the-core-ingest-logic)
9. [Complete Data Flow: Byte by Byte](#9-complete-data-flow-byte-by-byte)

---

## 1. The Service in One Paragraph

`hooks-api` is the **ingest frontier** of Zappy. Its one job: receive an HTTP POST from GitHub,
Razorpay, or any generic webhook provider, verify that the POST is authentic (HMAC-SHA256),
deduplicate the event, and write it atomically to both `webhook_events` and `outbox` in Postgres
— all inside one transaction, so either both writes happen or neither does.

It runs on **Port 3002**, isolated from the management API on Port 3001. This isolation is
deliberate: a DDoS storm of fake webhook POSTs hitting 3002 cannot starve the user-facing
management API on 3001.

It has **no `express.json()` middleware**. This is the single most important architectural
decision in the entire file. Read on.

---

## 2. `server.ts` — The Express Bootstrap

**File:** `apps/hooks-api/src/server.ts`

### Lines 1–9: Imports

```typescript
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { initSentry } from './lib/sentry';
import { webhookRouter } from './routes/webhook.routes';
import { logger } from './lib/logger';
```

**Why these imports and not others?**

- **`helmet`** — Sets 13 security HTTP headers in one call. Things like `X-Content-Type-Options: nosniff`
  and `X-Frame-Options: DENY`. Without it, an attacker's browser could MIME-sniff a JSON response as
  HTML and execute scripts.

- **`express-rate-limit`** — IP-based sliding window limiter. The npm package is a simple in-memory
  counter keyed by IP. Good enough here because hooks-api is behind a single reverse proxy, not
  horizontally scaled for rate limiting. If you scale to 3 instances, you'd need Redis-backed
  `rate-limit-redis`.

- **Notice: no `cors` import.** Webhooks come from third-party servers, not browsers. CORS headers
  are meaningless and absent by design.

---

### Lines 10–11: Sentry initialization order

```typescript
// Sentry must be initialised before any async code runs
initSentry();
```

**Why first?** Sentry works by monkey-patching Node's `http` module, `console`, and the `Error`
prototype at the time it's initialized. If you import Express before Sentry, Express's request
handlers are registered *before* Sentry's instrumentation is applied — so Sentry misses all
unhandled errors that originate inside Express route handlers. The comment in the code is law:
**Sentry before everything else**.

---

### Lines 14–15: Trust the proxy

```typescript
export const app = express();
app.set('trust proxy', 1);
```

**What this does:** Express reads the client IP from `req.ip`. In a Docker Compose setup with Nginx
or Traefik in front, the *real* client IP is in `X-Forwarded-For`, but `req.socket.remoteAddress`
is the container bridge IP (172.18.0.x). `trust proxy = 1` tells Express to trust one hop of
`X-Forwarded-For`. This makes the rate limiter work on actual client IPs, not Docker network IPs.
Without this, *every single IP-based rate limit* would count all requests as coming from the same
bridge IP — effectively disabling rate limiting.

---

### Lines 17–19: The most important comment in the codebase

```typescript
// NOTE: No express.json() here intentionally — rawBodyMiddleware captures raw bytes
// for HMAC verification. JSON parsing happens inside the service after verification.
app.use(helmet());
```

**The critical insight:** `express.json()` does two things: (1) reads the raw bytes off the TCP
stream, (2) calls `JSON.parse()` and replaces `req.body` with the parsed object. Once step 2
happens, the original byte sequence is gone.

This matters because HMAC-SHA256 is computed over the **exact raw bytes** that were transmitted.
GitHub computes `HMAC(secret, rawBodyBytes)`. If you parse the JSON and re-serialize it, tiny
differences (key ordering, Unicode escape sequences, trailing whitespace) will produce a different
HMAC. Your computed HMAC will never match. Verification will always fail.

`rawBodyMiddleware` captures the raw bytes *before* any parsing. JSON parsing happens later,
*after* verification, inside `webhook-ingest.service.ts`. This is not a minor detail — it's the
reason webhook verification works at all.

---

### Lines 22–27: Request logger (skips /health)

```typescript
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    logger.info({ method: req.method, url: req.url }, 'incoming request');
  }
  next();
});
```

**Why skip /health?** Health checks are called every 10-30 seconds by Docker's healthcheck and
load balancers. Without this filter, health check noise drowns out real webhook traffic in logs.
You'd be reading 60 `/health` lines per minute to find the one real webhook line.

---

### Lines 30–39: Health endpoint with DB probe

```typescript
app.get('/health', async (_req, res) => {
  try {
    const { prisma } = await import('@zapier-clone/db');
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true });
  } catch (err) {
    logger.error({ err }, '[hooks-api] Health check failed');
    res.status(503).json({ status: 'error', db: false });
  }
});
```

**Why dynamic import?** `await import('@zapier-clone/db')` defers the DB connection attempt until
the first health check is called. If imported at top level and Postgres is not yet ready in Docker,
the entire process crashes before the health endpoint is registered. The dynamic import lets the
service start and report "DB unhealthy" rather than crashing completely. This is a resilience
pattern for containerized startup races.

**Why `SELECT 1`?** It's the lightest possible DB round-trip — no table scans, no locks. It
verifies only that the Postgres TCP connection is alive and the server responds.

---

### Lines 42–48: Rate limiter

```typescript
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});
```

**Why 300/min?** Most webhook providers have their own throttles (GitHub: 5000 events/hour per
repo). 300/min = 5/sec allows even a busy webhook stream while blocking naive flood attacks.
`standardHeaders: 'draft-7'` adds IETF-standardized `RateLimit-Policy` headers. `legacyHeaders:
false` suppresses older `X-RateLimit-*` headers, reducing response size.

---

### Lines 53–60: Global error handler

```typescript
app.use((err: Error & { statusCode?: number }, _req, res, _next) => {
  const statusCode = err.statusCode ?? 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;
  logger.error({ err, statusCode }, '[hooks-api] unhandled error');
  res.status(statusCode).json({ error: message });
});
```

**Why 4 parameters?** Express distinguishes error-handling middleware by arity — it must declare
`(err, req, res, next)` with exactly 4 params. With 3 params, Express treats it as regular
middleware and never passes errors to it.

**Why hide 500 message?** For status 500, we return the generic `'Internal server error'` instead
of `err.message`. This prevents stack traces, Prisma query details, or internal class names from
leaking to external callers. For 4xx errors (`statusCode` set intentionally), the message is safe.

---

### Lines 63–67: Conditional listen

```typescript
if (require.main === module) {
  app.listen(env.HOOKS_API_PORT, () => {
    logger.info({ port: env.HOOKS_API_PORT }, '🪝  hooks-api started');
  });
}
```

**Why `require.main === module`?** This guard allows `server.ts` to be imported by test files
without starting a live HTTP server. In Vitest tests, you import the `app` object and use
`supertest` to make in-process requests. If `app.listen()` ran unconditionally, every test would
try to bind Port 3002 and fail with `EADDRINUSE`. The guard is essential for testability.

---

## 3. `lib/logger.ts` — Structured Logging

**File:** `apps/hooks-api/src/lib/logger.ts`

```typescript
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }
    : {}),
  base: { service: 'hooks-api' },
});
```

**Why Pino and not `console.log`?** Two reasons:

1. **Performance:** `console.log` is synchronous — every call blocks the Node.js event loop until
   the string is flushed to stdout. Pino serializes to JSON and writes asynchronously. For a
   high-throughput webhook ingestor receiving dozens of webhooks per second, this matters.

2. **Structure:** `console.log('webhook received', zapId)` produces a flat string. You cannot
   query it. `logger.info({ zapId, stepId, eventId }, 'webhook received')` produces:
   ```json
   {"service":"hooks-api","zapId":"123","stepId":"5","eventId":"abc","msg":"webhook received"}
   ```
   A log aggregator (Datadog, Loki) can filter on `zapId=123` instantly.

**`base: { service: 'hooks-api' }`** — Pino merges this object into every log line. So every
single log from this service automatically includes `"service":"hooks-api"`. In a monorepo where
`worker`, `relay`, and `hooks-api` all write to the same log stream, you can filter by `service`.

**Dev vs Production transport:** In dev, `pino-pretty` formats logs with colors and human-readable
timestamps. In production, logs are raw JSON Lines — one JSON object per line — which log
aggregators parse independently. The `ignore: 'pid,hostname'` option strips irrelevant noise from
the pretty output.

---

## 4. `lib/sentry.ts` — Error Monitoring

**File:** `apps/hooks-api/src/lib/sentry.ts`

```typescript
import * as Sentry from '@sentry/node';
import { env } from '../config/env';

export function initSentry(): void {
  if (!process.env.SENTRY_DSN) {
    return; // No-op in local dev
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 0,
    integrations: [Sentry.httpIntegration()],
  });
}

export { Sentry };
```

**What Sentry does:** When `Sentry.init()` is called, the SDK patches Node's unhandled rejection
handler, patches `http.IncomingMessage` to capture incoming HTTP request context, and registers a
global error boundary. Every unhandled exception or captured error is serialized (stack trace,
breadcrumbs, request headers, user context) and posted to Sentry's ingest API asynchronously.

**`if (!process.env.SENTRY_DSN) return;`** — makes Sentry completely optional for local
development. Without a DSN, `Sentry.init()` would silently no-op anyway, but the guard makes
intent explicit.

**`tracesSampleRate: 0.1`** — Sentry can capture distributed performance traces. 10% sampling in
production is a balance between coverage and Sentry data cost. `0` in non-production means zero
performance overhead during development.

**`httpIntegration()`** — automatically captures HTTP request details (method, URL, headers, body)
as context for every error. Without it, Sentry error reports would lack request context.

**`export { Sentry }`** — re-exporting allows other modules to call `Sentry.captureException(err)`
by importing from this file, without needing to import from `@sentry/node` directly. Single place
to swap error monitoring provider.

---

## 5. `middleware/raw-body.middleware.ts` — Byte-Level Body Capture

**File:** `apps/hooks-api/src/middleware/raw-body.middleware.ts`

This is the most important piece of infrastructure in the entire `hooks-api`. Without it, HMAC
verification is impossible.

### Line 3: Size limit constant

```typescript
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB
```

**Why 5MB?** Most webhook payloads are small — a GitHub push event is a few KB, a Razorpay payment
event is under 1KB. 5MB gives a massive safety margin for large payloads while preventing memory
exhaustion. A 5MB body takes at most 5MB of RAM to buffer. Without this limit, a malicious caller
could POST a 500MB body and exhaust the Node.js heap. The HTTP connection stays open while the
body streams in, letting the attacker hold the server hostage.

### Lines 18–19: Chunk accumulator setup

```typescript
const chunks: Buffer[] = [];
let totalBytes = 0;
```

**Why an array of Buffers?** TCP does not guarantee that an HTTP body arrives in one shot. The
underlying `net.Socket` emits the body as a stream of `data` events. Each `data` event carries a
`Buffer` (a raw chunk of bytes). Accumulating them in an array avoids O(N²) string concatenation.
`Buffer.concat(chunks)` at the end does a single allocation and copies all chunks — O(N) total.

**Why `Buffer` and not `string`?** `Buffer` preserves the exact bytes. HMAC-SHA256 operates on
bytes, not decoded strings. If you use `req.setEncoding('utf8')` and accumulate strings, Node
decodes bytes using UTF-8, which is lossy for certain byte sequences. Keeping it as `Buffer`
ensures no encoding conversion happens until explicitly calling `rawBody.toString('utf8')` — after
verification.

### Lines 21–29: The `data` event listener

```typescript
req.on('data', (chunk: Buffer) => {
  totalBytes += chunk.length;
  if (totalBytes > MAX_BODY_BYTES) {
    res.status(413).json({ error: 'Payload too large (max 5MB)' });
    req.destroy();
    return;
  }
  chunks.push(chunk);
});
```

- `req.on('data', ...)` — registers a listener on the raw TCP stream events. `req` is a
  `http.IncomingMessage` which is a `Readable` stream.
- `totalBytes += chunk.length` — running counter. `chunk.length` is in bytes.
- `if (totalBytes > MAX_BODY_BYTES)` — the check happens incrementally, not after the full body
  is received. This means we reject the request after the first chunk that puts us over the limit.
  We don't let the entire 500MB stream in first.
- `res.status(413)` — HTTP 413 Payload Too Large. Some webhook providers retry on 5xx but not 4xx,
  so this correctly signals "don't retry, your payload is too large."
- `req.destroy()` — forcibly terminates the TCP connection. Without this, after sending 413, the
  client might keep streaming the rest of the body. `req.destroy()` closes the socket immediately.
  The `return` after it is important — without it, the function continues and pushes the oversized
  chunk into `chunks`.

### Lines 31–34: The `end` event listener

```typescript
req.on('end', () => {
  (req as Request & { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
  next();
});
```

**`end` event** — fires when the entire body has been read. At this point all chunks are available.

**`Buffer.concat(chunks)`** — single O(N) copy. Produces one flat `Buffer` containing all bytes.

**`(req as Request & { rawBody: Buffer }).rawBody`** — TypeScript intersection type cast. Express's
`Request` type doesn't define `rawBody`. The cast `Request & { rawBody: Buffer }` adds the
property to the type. This is a TypeScript escape hatch, not unsafe at runtime.

**`next()`** — passes control to the next middleware. Without it, the request hangs forever. Every
non-terminal Express middleware must call `next()` exactly once.

### Line 36: Error propagation

```typescript
req.on('error', next);
```

**Why `next` as the error handler?** If the TCP connection is reset mid-stream (client
disconnects), Node emits an `error` event on the readable stream. Without this handler, the error
is an unhandled event emitter error and crashes the process. Passing `next` means any stream error
is forwarded to Express's error handling middleware chain.

---

## 6. `services/hmac-verify.service.ts` — Cryptographic Signature Verification

**File:** `apps/hooks-api/src/services/hmac-verify.service.ts`

```typescript
import crypto from 'crypto';
```

Node's built-in `crypto` module. Uses OpenSSL under the hood. No third-party HMAC libraries —
a crypto implementation with no external dependencies has the smallest attack surface.

### Lines 19–27: Computing our HMAC

```typescript
export function verifyWebhook(
  rawBody: Buffer,
  receivedSignature: string,
  secret: string,
): boolean {
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
```

- `createHmac('sha256', secret)` — creates an HMAC-SHA256 context. The `secret` is the
  webhook secret stored in `zap_steps.webhook_secret` for this trigger step. Generated with
  `crypto.randomBytes(32).toString('hex')` at zap creation time — 256 bits of entropy,
  unguessable.
- `.update(rawBody)` — feeds the raw bytes into the HMAC. The entire raw body is the message
  being authenticated. This is why `rawBodyMiddleware` captures bytes before JSON parsing.
- `.digest('hex')` — finalizes the HMAC computation and returns the result as a lowercase hex
  string. HMAC-SHA256 output is always 32 bytes = 64 hex characters.

**What this proves:** If the sender knows the same `secret` and computed HMAC over the same body
bytes, their result will match ours. Without the secret, the probability of guessing a valid HMAC
for a specific body is 1/2^256.

### Lines 30–32: Signature normalization

```typescript
const normalizedSignature = receivedSignature.startsWith('sha256=')
  ? receivedSignature.slice(7)
  : receivedSignature;
```

**Why normalize?** GitHub sends `X-Hub-Signature-256: sha256=<hex>`. Razorpay sends
`X-Razorpay-Signature: <hex>` (no prefix). `slice(7)` removes the 7-character prefix `sha256=`.
After this, `normalizedSignature` is always a raw hex string regardless of provider.

### Lines 34–35: Convert to Buffers for timingSafeEqual

```typescript
const computedBuf = Buffer.from(computed, 'hex');
const receivedBuf = Buffer.from(normalizedSignature, 'hex');
```

`timingSafeEqual` requires `Buffer` (or `TypedArray`) arguments, not strings. `Buffer.from(hex,
'hex')` decodes a hex string to its 32-byte binary representation. If `normalizedSignature` is
not valid hex, `Buffer.from` with `'hex'` encoding silently stops early — the resulting buffer
may be shorter than 32 bytes, caught by the length guard.

### Lines 37–38: Length guard

```typescript
if (computedBuf.length !== receivedBuf.length) return false;
```

**Required.** `crypto.timingSafeEqual` throws a `TypeError` if the two buffers have different
lengths. This guard converts that throw into a clean `false` return. If the received signature
is garbage (not a valid 64-char hex string), `Buffer.from` will produce a shorter buffer.

### Line 40: Timing-safe comparison

```typescript
return crypto.timingSafeEqual(computedBuf, receivedBuf);
```

**The timing attack problem:** If you used `computed === normalizedSignature`, JavaScript's string
comparison does an early return on the first mismatching character. An attacker can measure the
response time of thousands of requests with different forged signatures. Over millions of requests,
this timing oracle reveals the correct signature one character at a time. This is a **timing
side-channel attack**.

`crypto.timingSafeEqual` prevents this — it compares all bytes in constant time, always taking
the same amount of time regardless of where the mismatch is:

```
Naive comparison:    E[time] = k * position_of_first_mismatch
timingSafeEqual:     E[time] = k * 32 (always, regardless of match position)
```

---

## 7. `controllers/webhook.controller.ts` — The HTTP Orchestrator

**File:** `apps/hooks-api/src/controllers/webhook.controller.ts`

The controller sits between the Express route and the ingest service. Its responsibilities:
extract relevant data from HTTP request headers, call the service, translate results to HTTP
responses.

### Line 6: Type alias for raw request

```typescript
type RawRequest = Request & { rawBody: Buffer };
```

A local TypeScript intersection type. `rawBody` is added by `rawBodyMiddleware`. This alias lets
the controller access `req.rawBody` without TypeScript errors.

### Lines 15–18: Numeric ID guard

```typescript
if (!/^\d+$/.test(zapId) || !/^\d+$/.test(stepId)) {
  res.status(200).json({ received: true });
  return;
}
```

**Why this guard?** `BigInt("abc")` throws a `SyntaxError`. Without the guard, any request to
`/hooks/abc/xyz` would throw, be caught, and return 500 — triggering Sentry alerts and false
error metrics. The regex `/^\d+$/` matches only strings of one or more digits.

**Why 200 and not 404?** Returning 404 tells an attacker "this route exists but the ID doesn't."
Returning 200 reveals nothing — the attacker cannot distinguish "invalid ID format" from "valid
ID that doesn't exist." Information hiding.

### Lines 25–29: Signature header — priority waterfall

```typescript
const signature =
  (req.headers['x-hub-signature-256'] as string) ??
  (req.headers['x-razorpay-signature'] as string) ??
  (req.headers['x-webhook-signature'] as string) ??
  '';
```

**Priority order:** GitHub's header first, then Razorpay, then generic. If none are present,
`signature` is `''`. An empty signature will fail HMAC verification — correct behavior.

**`??` vs `||`:** `??` (nullish coalescing) falls through only on `null` or `undefined`. Empty
string `''` does NOT fall through. This matters: if `x-hub-signature-256: ""` is present, we
use it as the signature (which will fail verification), rather than silently picking up another
provider's header. `||` would fall through on `''`, potentially causing incorrect behavior.

### Lines 36–40: Event ID — deduplication key

```typescript
const eventId =
  (req.headers['x-github-delivery'] as string) ??
  (req.headers['x-razorpay-event-id'] as string) ??
  (req.headers['x-webhook-id'] as string) ??
  `${zapId}-${randomUUID()}`;
```

`event_id` is the key in `ON CONFLICT (event_id, zap_id) DO NOTHING` — the deduplication
constraint. If the same webhook is delivered twice (network retry), both deliveries carry the
same `event_id`. The second INSERT silently does nothing.

Fallback: `${zapId}-${randomUUID()}` — a random UUID. Generic webhooks without `X-Webhook-Id`
will not deduplicate across retries, but will always have a unique ID.

### Lines 51–66: The response matrix

```typescript
switch (result.status) {
  case 'unauthorized':
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  case 'not_found':
    res.status(200).json({ received: true });
    return;
  case 'ingested':
  case 'duplicate':
  case 'skipped':
    res.status(200).json({ received: true });
    return;
}
```

| Service status  | HTTP status | Reason |
|-----------------|-------------|--------|
| `unauthorized`  | 401         | HMAC failed — reveal reason so devs can debug |
| `not_found`     | 200         | Don't reveal if zapId/stepId exists |
| `ingested`      | 200         | Success — always 200 to prevent provider retry |
| `duplicate`     | 200         | Already have this event — suppress retry |
| `skipped`       | 200         | GitHub event type didn't match — not an error |
| Thrown exception| 500         | DB crash — provider SHOULD retry |

**Why 500 on exception?** For webhook providers, 500 means "something went wrong, retry later."
If we returned 200 on a DB crash, the provider thinks we successfully received the event and stops
retrying. We'd lose the webhook permanently. 500 ensures the provider retries once the DB recovers.

---

## 8. `services/webhook-ingest.service.ts` — The Core Ingest Logic

**File:** `apps/hooks-api/src/services/webhook-ingest.service.ts`

### 8.1 The IngestStatus Union (Line 6)

```typescript
export type IngestStatus = 'ingested' | 'duplicate' | 'unauthorized' | 'not_found' | 'skipped';
```

TypeScript **string literal union**. Every terminal path in `ingestWebhook` returns one of these
five values. The controller's `switch` is exhaustive over this union — TypeScript fails to compile
if a new status is added without handling it. The type system enforces complete handling.

### 8.2 The GitHub Trigger Routing Table (Lines 23–32)

```typescript
const GITHUB_TRIGGER_ROUTING: Record<
  string,
  { githubEvent: string; actionFilter?: string; refTypeFilter?: string }
> = {
  'github:push': { githubEvent: 'push' },
  'github:pull_request_opened': { githubEvent: 'pull_request', actionFilter: 'opened' },
  'github:issue_opened': { githubEvent: 'issues', actionFilter: 'opened' },
  'github:branch_created': { githubEvent: 'create', refTypeFilter: 'branch' },
  'github:release_published': { githubEvent: 'release', actionFilter: 'published' },
};
```

**Why a lookup table and not if/else?** A `Record<string, ...>` (dictionary) is O(1) lookup.
Adding a new trigger type is one line. No nested if/else logic to trace through.

**Understanding each entry:**

| `availableTriggerId` | `X-GitHub-Event` | `payload.action` | `payload.ref_type` | What it means |
|---|---|---|---|---|
| `github:push` | `push` | — | — | Any push to any branch |
| `github:pull_request_opened` | `pull_request` | `opened` | — | Only newly opened PRs |
| `github:issue_opened` | `issues` | `opened` | — | Only newly opened issues |
| `github:branch_created` | `create` | — | `branch` | A new branch (not tag) |
| `github:release_published` | `release` | `published` | — | A published release |

**The `actionFilter` problem:** GitHub's `pull_request` event fires for `opened`, `closed`,
`merged`, `synchronize`, etc. A user who sets up a "PR opened" trigger should NOT be notified
when an existing PR is closed. `actionFilter: 'opened'` narrows to exactly `opened`.

**The `refTypeFilter` problem:** GitHub's `create` event fires for both branch and tag creation.
`refTypeFilter: 'branch'` ensures only branch creation triggers the zap. Tag creation is silently
dropped with status `skipped`.

### 8.3 `matchesGitHubTrigger` — The Two-Tier System (Lines 39–61)

```typescript
export function matchesGitHubTrigger(
  availableTriggerId: string | null,
  githubEventType: string,
  payload: Record<string, unknown>,
): boolean {
  // Tier-2 catch-hook or non-GitHub trigger: always accept
  if (!availableTriggerId || !(availableTriggerId in GITHUB_TRIGGER_ROUTING)) {
    return true;
  }
  ...
}
```

**Tier 1 (Specific):** `availableTriggerId` is in the routing table → only matching events pass.
**Tier 2 (Generic):** `availableTriggerId` is null, or `webhooks:catch_hook`, or any ID not in
the table → every delivery passes unconditionally.

The condition `!availableTriggerId || !(availableTriggerId in GITHUB_TRIGGER_ROUTING)` reads:
"if the trigger ID is null/undefined OR is not one of our known GitHub-specific triggers, accept
everything." This correctly handles both `webhooks:catch_hook` and non-GitHub triggers (Razorpay).

### 8.4 `ingestWebhook` — The Five-Stage Pipeline (Lines 76–168)

**Stage 1: Look up the trigger step (Lines 84–99)**

```typescript
const step = await prisma.zapStep.findFirst({
  where: {
    id: BigInt(stepId),
    zapId: BigInt(zapId),
    stepType: 'trigger',
  },
  include: {
    zap: { select: { isActive: true, userId: true } },
  },
});
```

Why `findFirst` with `zapId` in the where? Even if you know `stepId`, you could be looking at a
step that belongs to a *different* zap (if IDs are guessable). The `zapId` constraint ensures the
step actually belongs to the zap in the URL. Application-level tenant boundary check.

Why `include: { zap: ... }`? We need `zap.isActive` and `zap.userId`. Using `include` is one
query (JOIN), not two sequential queries.

```typescript
if (!step || !step.webhookSecret) {
  return { status: 'not_found' };
}
if (!step.zap.isActive) {
  return { status: 'not_found' };
}
```

Two early exits returning the same `not_found` status — the controller responds 200 for both.
The caller learns nothing about which condition triggered. Information hiding.

**Stage 2: HMAC Verification (Lines 107–112)**

```typescript
const valid = verifyWebhook(rawBody, signature, step.webhookSecret);
if (!valid) {
  return { status: 'unauthorized' };
}
```

HMAC is called *after* the DB lookup because `verifyWebhook` needs `webhookSecret` from the DB.
You can't verify without it. This means one DB query always happens before rejection. Acceptable
trade-off — the DB lookup is cheap (indexed by primary key).

**Stage 3: JSON Parsing after verification (Lines 115–120)**

```typescript
let payload: Record<string, unknown>;
try {
  payload = JSON.parse(rawBody.toString('utf8'));
} catch {
  payload = { raw: rawBody.toString('utf8') };
}
```

**Only after verification.** Critical ordering: capture bytes → verify HMAC → parse JSON.

**Why catch JSON parse errors?** Some webhooks don't send JSON — they send form-encoded data or
plain text. Rather than failing, we wrap the raw string in `{ raw: "..." }`. This is captured in
`webhook_events.payload` and is available for user inspection. The trigger still fires.

**Stage 4: GitHub Event Routing (Lines 122–129)**

```typescript
if (githubEventType && !matchesGitHubTrigger(step.availableTriggerId, githubEventType, payload)) {
  return { status: 'skipped' };
}
```

`githubEventType && ...` — the entire check is skipped if `githubEventType` is empty (not a
GitHub delivery). Razorpay and generic webhooks always pass through to Stage 5.

`status: 'skipped'` — the controller maps this to 200. GitHub does not see an error. This is
correct: the webhook was received, verified as authentic, and consciously dropped because it
didn't match the configured trigger type.

**Stage 5: Atomic Transaction (Lines 131–165)**

```typescript
const result = await prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO webhook_events (event_id, zap_id, payload)
    VALUES (${eventId}, ${BigInt(zapId)}, ${payload}::jsonb)
    ON CONFLICT (event_id, zap_id) DO NOTHING
    RETURNING id
  `;
```

**`ON CONFLICT (event_id, zap_id) DO NOTHING RETURNING id`** — the deduplication mechanism.

The `webhook_events` table has a `UNIQUE(event_id, zap_id)` constraint. If the same `event_id`
from the same `zap_id` is inserted twice (webhook provider retry), the second INSERT does nothing
and returns no rows. `RETURNING id` returns the inserted row's `id` only if the INSERT actually
succeeded.

```typescript
  if (rows.length === 0) {
    return 'duplicate';
  }

  const webhookEventId = rows[0].id;

  // Immediately create the zap_run in 'queued' state for frontend visibility
  await tx.$executeRaw`
    INSERT INTO zap_runs (zap_id, webhook_event_id, status)
    VALUES (${BigInt(zapId)}, ${webhookEventId}, 'queued')
    ON CONFLICT (webhook_event_id) DO NOTHING
  `;
```

**Why create a `zap_run` here?** Frontend visibility. When the user opens the dashboard and looks
at run history, they want to see "queued" runs waiting to be processed. Without this insert,
there's a gap: the webhook arrives, outbox row is created, but `zap_runs` has nothing until the
worker processes it. The `ON CONFLICT DO NOTHING` handles the case where the run was already
created (defensive).

```typescript
  await tx.outbox.create({
    data: {
      webhookEventId,
      eventId,
      payload: payload as Prisma.InputJsonValue,
    },
  });

  return 'ingested';
});
```

**The outbox row.** This is the critical write that enables the Transactional Outbox pattern.
The `relay` daemon will pick this up and publish the Kafka message.

**Why inside the same transaction as `webhook_events`?** If `webhook_events` INSERT succeeds but
`outbox` INSERT fails (disk full, deadlock), the transaction rolls back both writes. The next
delivery from the provider will re-insert `webhook_events` (no conflict) and create the outbox
row. No event is lost.

Without the transaction, you could get partial state: `webhook_events` written, `outbox` not
written — the event would be received but never executed. **This is the dual-write problem, and
the transaction is the solution.**

---

## 9. Complete Data Flow: Byte by Byte

Here is the exact sequence of events when GitHub sends a push webhook to Zappy:

```
1. GitHub POST /hooks/42/7
   Headers:
     Content-Type: application/json
     X-Hub-Signature-256: sha256=<64-hex-chars>
     X-GitHub-Delivery: a1b2c3d4-...
     X-GitHub-Event: push
   Body (raw TCP): {"ref":"refs/heads/main","commits":[...]}  (89 bytes)

2. Express receives TCP stream → rawBodyMiddleware fires
   - req.on('data') fires 1+ times with Buffer chunks
   - chunks = [Buffer<bytes...>, ...]
   - totalBytes = 89 → never exceeds 5MB
   - req.on('end') fires → req.rawBody = Buffer.concat(chunks) = 89-byte Buffer

3. webhookLimiter: IP "185.199.108.x" (GitHub's IP)
   - counter for this IP = 1, under 300/min → passes

4. webhookRouter → handleWebhook
   - zapId = "42", stepId = "7"
   - regex guard passes
   - signature = "sha256=<64hex>" (from x-hub-signature-256)
   - eventId = "a1b2c3d4-..." (from x-github-delivery)
   - rawBody = 89-byte Buffer
   - githubEventType = "push"

5. ingestWebhook("42", "7", rawBody, "sha256=<64hex>", "a1b2c3d4-...", "push")

6. DB query 1: prisma.zapStep.findFirst
   SELECT zap_steps.*, zaps.is_active, zaps.user_id
   FROM zap_steps JOIN zaps ON zaps.id = zap_steps.zap_id
   WHERE zap_steps.id = 7 AND zap_steps.zap_id = 42 AND step_type = 'trigger'
   → Returns row with webhook_secret = "a3f7...64hexchars"

7. Zap is active → continue

8. verifyWebhook(rawBody, "sha256=<64hex>", "a3f7...64hexchars")
   - computed = HMAC-SHA256("a3f7...64hexchars", rawBody) → 64-char hex
   - normalizedSignature = "sha256=<64hex>".slice(7) = "<64hex>"
   - computedBuf = Buffer.from(computed, 'hex') → 32 bytes
   - receivedBuf = Buffer.from(normalizedSignature, 'hex') → 32 bytes
   - computedBuf.length === receivedBuf.length → true
   - timingSafeEqual(computedBuf, receivedBuf) → true ✓

9. JSON.parse(rawBody.toString('utf8'))
   → payload = { ref: "refs/heads/main", commits: [...] }

10. matchesGitHubTrigger("github:push", "push", payload)
    - "github:push" IS in GITHUB_TRIGGER_ROUTING
    - rule = { githubEvent: "push" }
    - "push" === "push" → true
    - no actionFilter, no refTypeFilter → skip
    → returns true → not skipped

11. prisma.$transaction:
    a. INSERT INTO webhook_events (event_id, zap_id, payload)
       VALUES ("a1b2c3d4-...", 42, payload::jsonb)
       ON CONFLICT (event_id, zap_id) DO NOTHING
       RETURNING id
       → rows = [{id: 1234n}] (new row)

    b. INSERT INTO zap_runs (zap_id, webhook_event_id, status)
       VALUES (42, 1234, 'queued')
       ON CONFLICT (webhook_event_id) DO NOTHING
       → run created, status = 'queued', visible in dashboard

    c. INSERT INTO outbox (webhook_event_id, event_id, payload)
       VALUES (1234, "a1b2c3d4-...", payload::jsonb)
       → outbox row created, status = 'pending'

    → COMMIT (all three writes are atomic)

12. return { status: 'ingested' }

13. res.status(200).json({ received: true })
    ← GitHub receives 200 OK in < 100ms

14. relay picks up outbox row (next poll cycle) → Kafka message published
15. worker receives Kafka message → sequential-executor runs → run completes
```

Total time from webhook arrival to DB write: **typically 20–80ms** (two DB queries + one
transaction). GitHub's timeout is 10 seconds — ample margin.

---

*Continue to: [DD2 — The Relay Daemon, Line by Line](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD2_RELAY_LINE_BY_LINE.md)*
