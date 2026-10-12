# Deep Dive 5 — `app-api`: Auth, Middleware, Connections & Runs: Every Line Explained

> This chapter covers the management API's full request lifecycle: how a raw HTTP request is
> authenticated, logged, validated, executed, and how errors propagate cleanly. It dissects
> every middleware, the entire auth system (bcrypt cost factor math, JWT HS256 design), the
> OAuth flow (state CSRF protection, token exchange, upsert semantics), the API key connection
> flow, the runs/history API with pagination, and the `serializeBigInt` recursive transformer.

---

## Table of Contents

1. [`server.ts` — The Management API Bootstrap](#1-serverts--the-management-api-bootstrap)
2. [`lib/serialize.ts` — The `serializeBigInt` Function](#2-libserializets--the-serializebigint-function)
3. [`middleware/error-handler.middleware.ts` — Centralized Error Handling](#3-middlewareerror-handlermiddlewarets--centralized-error-handling)
4. [`middleware/request-logger.middleware.ts` — Structured HTTP Logging](#4-middlewarerequest-loggermiddlewarets--structured-http-logging)
5. [`middleware/auth.middleware.ts` — JWT Verification](#5-middlewareauthmiddlewarets--jwt-verification)
6. [`controllers/auth.controller.ts` — Signup, Login, Me](#6-controllersauthcontrollerts--signup-login-me)
7. [`services/zap-validation.service.ts` — Zap Step Invariant Enforcement](#7-serviceszap-validationservicets--zap-step-invariant-enforcement)
8. [`services/connection-ownership.service.ts` — IDOR Prevention](#8-servicesconnection-ownershipservicets--idor-prevention)
9. [`controllers/connection.controller.ts` — OAuth & API Key Connections](#9-controllersconnectioncontrollerts--oauth--api-key-connections)
10. [`controllers/connectors.controller.ts` — The Global Catalog API](#10-controllersconnectorscontrollerts--the-global-catalog-api)
11. [`controllers/runs.controller.ts` — Execution History API](#11-controllersrunscontrollerts--execution-history-api)
12. [The Complete Request Lifecycle: One Request, Start to Finish](#12-the-complete-request-lifecycle-one-request-start-to-finish)

---

## 1. `server.ts` — The Management API Bootstrap

**File:** `apps/app-api/src/server.ts`

The `app-api` server is the largest single Express application in the codebase. It handles
everything users interact with directly: auth, zap CRUD, connection management, and run history.
The bootstrap order is a precise sequence — each line is placed where it is for a reason.

### Lines 1–3: Sentry MUST be first

```typescript
import { initSentry, Sentry } from './lib/sentry';
initSentry();
```

Imported and initialized before ANY other module. See DD1 §4 for the full explanation of why
Sentry must be first. The difference here: `app-api`'s `server.ts` also exports `Sentry` (not
just `initSentry`), because the graceful shutdown handler calls `Sentry.flush(2000)`.

### Lines 5–19: Import order significance

```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { prisma } from '@zapier-clone/db';
import { env } from './config/env';
import { authRouter } from './routes/auth.routes';
import { connectorsRouter } from './routes/connectors.routes';
import { connectionsRouter } from './routes/connections.routes';
import { zapsRouter } from './routes/zaps.routes';
import { runsRouter } from './routes/runs.routes';
import { errorHandler } from './middleware/error-handler.middleware';
import { requestLogger } from './middleware/request-logger.middleware';
import { startCronJobs } from './jobs';
import { logger } from './lib/logger';
```

Unlike `hooks-api`, `app-api` imports `cors`. The reason: the `app-api` is called by the browser
(the React/Next.js frontend). The browser enforces Same-Origin Policy — without a CORS response,
the browser silently drops the API's response. `hooks-api` has no CORS because it's called only
by webhook providers (servers), never by browsers.

`startCronJobs` — the four background jobs (recover-dispatched-outbox, stuck-outbox-alert,
outbox-cleanup, refresh-expiring-tokens) are started when `app-api` starts. They run as long-
lived `node-cron` tasks within the same process. No separate cron process needed.

### Lines 22–26: Trust proxy, app creation

```typescript
export const app = express();
app.set('trust proxy', 1);
```

Same as `hooks-api` — must trust one proxy hop for IP-based rate limiting to work correctly
behind Docker's Nginx/Traefik bridge. See DD1 §2 for full explanation.

### Lines 28–44: Middleware stack ordering

```typescript
app.use(helmet());
app.use(cors({ origin: env.WEB_APP_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);
```

**Ordering matters in Express.** Each `app.use()` registers a middleware that runs in order for
every request. Here's why each is placed exactly where it is:

1. **`helmet()`** first — sets security headers before any response can be sent, even by other
   middleware.

2. **`cors()`** second — the CORS preflight `OPTIONS` request must be handled before the request
   reaches auth middleware (CORS preflights don't carry credentials). If `authMiddleware` ran
   first, it would reject OPTIONS requests before CORS could respond.

3. **`express.json({ limit: '1mb' })`** third — parses JSON request bodies. The `1mb` limit
   prevents oversized JSON payloads from being buffered. Unlike `hooks-api`, we CAN use
   `express.json()` here because `app-api` never needs raw body bytes for HMAC verification.

4. **`requestLogger`** fourth — logs after body parsing so request body size is known. Placed
   after `express.json()` because it logs response status codes via the `finish` event.

### The CORS configuration: `credentials: true`

```typescript
app.use(cors({ origin: env.WEB_APP_URL, credentials: true }));
```

**Why `credentials: true`?** The `Access-Control-Allow-Credentials: true` header allows the
browser to include credentials (cookies, Authorization headers) in cross-origin requests. Without
this, the browser would block the `Authorization: Bearer <token>` header from being sent.

**Why `origin: env.WEB_APP_URL` (not `'*'`)?** Wildcard `origin: '*'` is incompatible with
`credentials: true` — the browser rejects this combination for security reasons (a wildcard with
credentials would allow any site to make authenticated requests as the user). We specify the exact
frontend URL. In development, `WEB_APP_URL = 'http://localhost:3000'`. In production, it's the
deployed frontend domain.

### Lines 35–44: Global rate limiter — defense in depth

```typescript
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(globalLimiter);
```

**200 requests/minute per IP** — this is the outer envelope. Inside this envelope, auth routes
have their own tighter limiter (10 requests/15 minutes). The global limiter catches:
- Scraping bots enumerating zap IDs
- Accidental tight polling loops from frontend bugs
- Slow DoS attempts flooding any endpoint

**Why not apply the global limiter in `hooks-api`?** `hooks-api` uses 300/min (higher, because
webhook providers legitimately fire many events). `app-api`'s 200/min is lower because it's a
user-facing API — no legitimate user makes 200 management API calls per minute.

### Lines 47–57: Health endpoint

Same pattern as `hooks-api` — dynamic `prisma` import, `SELECT 1` DB probe, 200/503. The key
difference: `app-api`'s health check only verifies the DB. It does NOT check Redis or Kafka,
because `app-api` doesn't use Redis or Kafka directly (the worker does). Checking dependencies
you don't own is an anti-pattern — it means `app-api`'s health depends on services it can't
control.

### Lines 59–64: Route mounting

```typescript
app.use('/auth', authRouter);
app.use('/connectors', connectorsRouter);
app.use('/connections', connectionsRouter);
app.use('/zaps', zapsRouter);
app.use('/runs', runsRouter);
```

**No auth middleware here at the router level** — each router decides which of its routes need
authentication. This allows `POST /auth/signup` and `POST /auth/login` to be public (no token
required) while `GET /auth/me` requires a JWT. If we applied `authMiddleware` globally here,
login and signup would reject themselves.

### Lines 66–67: Error handler — MUST be last

```typescript
app.use(errorHandler);
```

**Why must the error handler be last?** Express's error handling middleware signature has 4
parameters `(err, req, res, next)`. Express only routes to error-handling middleware when a
previous middleware calls `next(err)` (passes an error). If `errorHandler` were registered before
the routes, it would never be reached because Express routes to middlewares in order — only after
all regular middlewares have had a chance to handle the request, and only if `next(err)` was
called, does Express look for the first 4-parameter middleware.

### Lines 70–95: Conditional server start and graceful shutdown

```typescript
if (require.main === module) {
  startCronJobs();
  const server = app.listen(env.APP_API_PORT, () => {
    logger.info({ port: env.APP_API_PORT }, '🚀  app-api running');
  });

  const shutdown = async (signal: string) => {
    logger.info(`[app-api] ${signal} received — draining connections`);
    server.close(async () => {
      await Sentry.flush(2000).catch(() => {});
      await prisma.$disconnect();
      logger.info('[app-api] Shutdown complete');
      process.exit(0);
    });

    // Force-exit after 30s if drain takes too long
    setTimeout(() => {
      logger.warn('[app-api] Forced exit after 30s shutdown timeout');
      process.exit(1);
    }, 30_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}
```

**`server.close(callback)`** — stops the HTTP server from accepting new connections, then calls
the callback once all existing connections have been closed. This allows in-flight requests to
complete before the process exits. "Draining" is the key word — we don't kill in-flight requests.

**`Sentry.flush(2000)`** — waits up to 2 seconds for Sentry to send any pending events. If a 500
error happened just before SIGTERM, this ensures the Sentry event is dispatched before the process
exits. `.catch(() => {})` — if flush times out, ignore it and proceed with shutdown. Sentry must
never block the shutdown sequence.

**`setTimeout(..., 30_000)`** — the nuclear option. If `server.close()` callback doesn't fire
within 30 seconds (e.g., a long-polling connection keeps the server alive), force-exit with code
1. Code 1 causes Docker to restart the container. This is the correct behavior — a 30-second drain
timeout means something is wrong, and restarting with a fresh state is better than hanging forever.

**`require.main === module`** — same testability guard as `hooks-api`. Tests import `app` without
starting the server. See DD1 §2 for full explanation.

---

## 2. `lib/serialize.ts` — The `serializeBigInt` Function

**File:** `apps/app-api/src/lib/serialize.ts`

```typescript
export function serializeBigInt(obj: unknown): any {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}
```

**The full problem:** Prisma maps `BIGSERIAL` and `BIGINT` PostgreSQL columns to JavaScript
`bigint` (not `number`). The distinction matters: `number` can only safely represent integers up
to 2^53 - 1 (≈ 9 quadrillion). `BIGINT` can hold up to 2^63 - 1 (≈ 9.2 quintillion). For a
system with auto-incrementing IDs, you won't realistically hit 2^53, but correctness demands we
use the right type.

**`JSON.stringify` throws on `bigint`:** Node's built-in JSON serializer does not support
`bigint`. This is intentional — there's no JSON primitive for bigint. If you try
`JSON.stringify({ id: 42n })`, you get:
```
TypeError: Do not know how to serialize a BigInt
```

**The replacer function:** `JSON.stringify(obj, replacerFn)` accepts a second argument — a
function called for every key-value pair in the object. If it returns the value unchanged, that
value is serialized normally. If it returns a different value, that value is used instead. Our
replacer converts `bigint` → `string` and passes everything else through unchanged.

**The double JSON round-trip:** `JSON.parse(JSON.stringify(obj, replacer))` — why parse back?

The `JSON.stringify` call with the replacer converts `bigint` → `string` and produces a JSON
string. `JSON.parse` converts that JSON string back to a plain JavaScript object. The result is a
deep copy of `obj` where all `bigint` values have been replaced with their string representations.

Why not just use the replacer and return the JSON string directly? Because the controllers pass
the serialized object to `res.json()`, which calls `JSON.stringify()` internally. If we returned
a JSON string, it would be double-stringified (string inside a JSON string). `JSON.parse` ensures
we return a plain object that `res.json()` serializes correctly.

**`return any`** — the TypeScript return type is `any`. This is the one deliberate use of `any`
in the codebase. The reason: `serializeBigInt` transforms the type of the object — it converts
all `bigint` fields to `string`. TypeScript doesn't have a way to express "same shape as T but
with all bigint fields replaced by string" as a generic constraint. Using `any` allows the caller
to use the result without type errors, at the cost of type safety at the return boundary. The
`eslint-disable` comment above acknowledges this.

**Usage pattern:**
```typescript
// Without serializeBigInt → crashes with TypeError: Do not know how to serialize a BigInt
res.json({ id: 42n, name: 'My Zap' });

// With serializeBigInt → works, sends { id: "42", name: "My Zap" }
res.json(serializeBigInt({ id: 42n, name: 'My Zap' }));
```

**Recursive by nature:** `JSON.stringify` with a replacer processes ALL nested keys, including
nested objects and arrays. So `serializeBigInt({ zap: { id: 42n, steps: [{ id: 7n }] } })`
correctly converts all nested bigints: `{ zap: { id: "42", steps: [{ id: "7" }] } }`.

---

## 3. `middleware/error-handler.middleware.ts` — Centralized Error Handling

**File:** `apps/app-api/src/middleware/error-handler.middleware.ts`

### The `AppError` interface

```typescript
export interface AppError extends Error {
  statusCode?: number;
}
```

A structural extension of the built-in `Error`. Adds one optional field: `statusCode`. This is
how we distinguish application-level errors (which have a status code we set intentionally) from
unexpected errors (where `statusCode` is undefined, treated as 500).

**Why not a class?** A class `AppError extends Error` would work, but every `throw createError()`
call would need `new AppError(...)`. Using an interface + `createError()` factory function is
more concise:
```typescript
// With class:
throw new AppError('Not found', 404);

// With factory function:
throw createError('Not found', 404);
```

The factory function approach also avoids the `instanceof` pitfalls that come with class-based
errors in TypeScript (transpilation can break `instanceof` checks across module boundaries).

### `errorHandler` — the 4-parameter middleware

```typescript
export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;

  if (statusCode === 500) {
    logger.error({ err }, '[app-api] unhandled 500 error');
    Sentry.captureException(err);
  }

  res.status(statusCode).json({ error: message });
}
```

**The Sentry integration point:** Only 500 errors are sent to Sentry. 4xx errors are expected
(validation errors, auth failures, not-found) and do not need monitoring — they're client errors,
not server problems. 500 errors indicate something unexpected happened (DB crash, null dereference,
unhandled exception). Those are the ones that need immediate attention.

**`Sentry.captureException(err)`** — sends the full `Error` object to Sentry, including:
- The error message
- The full stack trace
- The request context (URL, method, headers) automatically attached by `httpIntegration()`
- Any Sentry breadcrumbs that were captured before the error

**The message concealment:** For `statusCode === 500`, we send `'Internal server error'` to the
client, not `err.message`. But we DO send `err.message` to Sentry (via the full `err` object).
The operator sees the real error in Sentry; the client sees a safe generic message.

For `statusCode < 500`, we send `err.message` directly — these messages are written by our own
code in `createError()` calls and are safe to expose:
```typescript
throw createError('Zap not found', 404);  // 'Zap not found' is safe to expose
throw createError('You do not have access to this connection', 403);  // Also safe
```

### `createError` — the factory function

```typescript
export function createError(message: string, statusCode: number): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}
```

**`new Error(message) as AppError`** — creates a standard `Error` object (which has a stack
trace) and casts it to `AppError`. The cast is safe because `AppError` is a structural type that
extends `Error` — the cast just tells TypeScript "this error has the extra `statusCode` field."

**Why `new Error` and not `new AppError`?** Because `AppError` is an interface, not a class.
Interfaces exist only at compile time. At runtime, there's no `AppError` constructor. We create
a real `Error` (which exists at runtime) and add the `statusCode` property to it.

**Stack trace value:** Calling `new Error(message)` captures the current call stack at the point
of the `throw`. This stack trace appears in Sentry for 500 errors, pointing to the exact line
where the error originated.

---

## 4. `middleware/request-logger.middleware.ts` — Structured HTTP Logging

**File:** `apps/app-api/src/middleware/request-logger.middleware.ts`

```typescript
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health') {
    next();
    return;
  }

  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }, `${req.method} ${req.path} ${res.statusCode} ${durationMs}ms`);
  });

  next();
}
```

### The `finish` event pattern

**Why listen to `res.on('finish')` and not just log at the start?** Because we need the response
status code and duration. These are only known AFTER the response is sent:
- Status code: set by the route handler or error handler.
- Duration: calculated as `Date.now() - start` where `start` is captured at request arrival.

The `finish` event fires when the response has been fully transmitted (headers and body sent). At
this point, `res.statusCode` has its final value.

**Alternative approach — not used:** `morgan` is a popular HTTP logging middleware. We use custom
Pino logging instead because:
1. `morgan` produces unstructured log strings. Pino produces JSON objects.
2. A structured log `{ method, path, status, durationMs, ip }` is queryable. A string
   `"GET /zaps/42 200 45ms"` is not.
3. We control the log level based on status code — 5xx errors are logged at `error` level, 4xx
   at `warn` level. Morgan uses a single fixed log level.

### Dynamic log level selection

```typescript
const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
logger[level]({ ... }, '...');
```

`logger[level]` — calls the Pino logger method dynamically by name: `logger.error`,
`logger.warn`, or `logger.info`. This is the ternary-chained level selector:
- `5xx` → `error`: Server crashed, DB unreachable, unhandled exception
- `4xx` → `warn`: Client sent bad data, not found, unauthorized — expected but worth logging
- `2xx / 3xx` → `info`: Normal operations

In a log aggregation dashboard (Datadog, Loki), you can filter `level=error` to see only HTTP
500 requests, then drill into `path` and `durationMs` to identify the failing endpoint.

### The `/health` exclusion

`req.path === '/health'` — checked first, before `Date.now()` is captured. This means:
1. No timer setup for health checks (minor performance saving, repeated 60 times/minute)
2. No `res.on('finish')` listener registered for health checks
3. Health checks never appear in logs

Without this exclusion, a production system running health checks every 10 seconds would generate
6 log lines per minute per service from health checks alone — pure noise drowning out real logs.

---

## 5. `middleware/auth.middleware.ts` — JWT Verification

**File:** `apps/app-api/src/middleware/auth.middleware.ts`

```typescript
export interface AuthenticatedRequest extends Request {
  userId: bigint;
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    (req as AuthenticatedRequest).userId = BigInt(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
```

### `AuthenticatedRequest` interface

```typescript
export interface AuthenticatedRequest extends Request {
  userId: bigint;
}
```

The TypeScript type system cannot know at compile time whether `req` has `userId` — it depends
on whether `authMiddleware` ran for this route. By defining `AuthenticatedRequest` and casting
`req as AuthenticatedRequest` in route handlers that are protected by `authMiddleware`, we assert
"this handler is always called with auth middleware, so `userId` is always present."

**Why `bigint` not `string` or `number`?** The JWT `sub` claim stores `userId.toString()`. When
we read it back, we convert with `BigInt(payload.sub)`. Storing as `bigint` on the request object
means all downstream DB calls get the correct `bigint` type without repeated conversion.

### `authHeader?.startsWith('Bearer ')`

The optional chaining `?.` handles the case where `authHeader` is `undefined` (the header is
absent). Without optional chaining, `authHeader.startsWith(...)` would throw `TypeError: Cannot
read property 'startsWith' of undefined`.

**Why check `startsWith('Bearer ')` (with a space)?** The full header format is:
`Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.xxx`

The scheme name is `Bearer` and the actual token follows a space. Without checking for `' '`
(space), a malformed header like `Authorization: BearerXXX` would pass the prefix check. The
space-inclusive `'Bearer '` check (7 characters) is also exactly what `slice(7)` below removes.

### `authHeader.slice(7)` — extracting the token

`'Bearer '.length === 7`. `authHeader.slice(7)` removes `'Bearer '` and returns just the JWT
string. Equivalent to `authHeader.replace(/^Bearer /, '')` but faster (O(1) vs regex overhead).

### `jwt.verify(token, env.JWT_SECRET)`

```typescript
const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
```

**What `jwt.verify` does:**
1. Splits the JWT into its three base64url-encoded parts: `header.payload.signature`
2. Decodes the header to find the algorithm (`alg: "HS256"`)
3. Recomputes `HMAC-SHA256(header.payload, JWT_SECRET)` and compares to the signature
4. Checks that `exp` (expiry) hasn't passed
5. Returns the decoded payload on success, throws on any failure

**Why HS256 (HMAC-SHA256) and not RS256 (RSA)?**

HS256 uses the same secret to sign and verify — symmetric. RS256 uses a private key to sign and
a public key to verify — asymmetric.

RS256 is needed when multiple services need to verify tokens independently without sharing a
secret (e.g., microservices where Service B has Service A's public key but not its private key).

In Zappy's architecture, ONLY `app-api` issues and verifies tokens. There's no multi-service JWT
verification (the worker and relay don't accept JWTs — they read from Kafka and DB directly).
HS256 is simpler and faster. RS256 is unnecessary complexity here.

**`as { sub: string }`** — a type cast. `jwt.verify` returns `JwtPayload | string`. We know
our tokens always have `sub` as a string (set in `issueToken`). The cast narrows the type.

**`BigInt(payload.sub)`** — `payload.sub` is `"42"` (the userId as a string). `BigInt("42")`
converts it to the native `42n` bigint. All DB queries use bigint IDs, so this conversion must
happen here, not in each route handler.

### Catch block — no information leakage

```typescript
} catch {
  res.status(401).json({ error: 'Invalid or expired token' });
}
```

The catch block doesn't log the error or distinguish between:
- `JsonWebTokenError` (malformed token)
- `TokenExpiredError` (valid token that expired)
- `NotBeforeError` (token used before its `nbf` claim)

All three return the same `'Invalid or expired token'` response. Why not distinguish? Telling
the client "your token is expired" vs "your token is malformed" leaks information about the
system's security model. From the client's perspective, all JWT failures have the same remediation:
get a new token (call `/auth/login`).

---

## 6. `controllers/auth.controller.ts` — Signup, Login, Me

**File:** `apps/app-api/src/controllers/auth.controller.ts`

### Zod schemas (Lines 11–20)

```typescript
const signupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),  // No min — "wrong password" feedback is better than "too short"
});
```

**Why no `password.min(8)` in `loginSchema`?** On signup, we enforce minimum length to prevent
weak passwords. On login, we do NOT enforce minimum length — if the user submits `"pass"`, we
let the password comparison run. This is because:

1. We don't want to tell an attacker "this user exists but their password is less than 8
   characters." The validation would fire before we check if the user exists.
2. The user might have an old account with a short password (before the policy was enforced).
   They should be allowed to log in, not blocked by the current policy.

**`z.string().email()`** — Zod's built-in email validator. Uses regex: checks for `@` and a
TLD. Not RFC 5322-complete (doesn't handle all edge cases), but good enough for most valid emails.

**`safeParse` vs `parse`:**
```typescript
const body = signupSchema.safeParse(req.body);
if (!body.success) {
  res.status(400).json({ error: body.error.flatten().fieldErrors });
  return;
}
```

`safeParse` returns `{ success: true, data: ... }` or `{ success: false, error: ZodError }`.
It does NOT throw on validation failure. This allows us to manually format the error response
with `flatten().fieldErrors` — a human-readable field-level error map:
```json
{ "email": ["Invalid email"], "password": ["String must contain at least 8 character(s)"] }
```

`parse()` (the alternative) throws a `ZodError` on failure. This would propagate to the `catch`
block and then to the error handler, which would format it as a generic 400 error. We prefer
`safeParse` for auth routes because we want structured field errors for the frontend form.

### `bcrypt.hash(password, 12)` — the cost factor math

```typescript
const passwordHash = await bcrypt.hash(password, 12);
```

**What bcrypt cost factor 12 means:**

Bcrypt is intentionally slow. The cost factor `12` means the algorithm runs `2^12 = 4096`
iterations of its core hash function. On a modern CPU (2024):
- Cost 10: ~100ms per hash
- Cost 12: ~300-400ms per hash
- Cost 14: ~1-2 seconds per hash

**Why slow?** To make brute-force attacks expensive. If an attacker steals the hashed passwords
table from the DB, they must try every password against bcrypt. With cost 12, on a GPU (the
attacker's tool of choice), they can try ~1000 hashes/second. Cracking an 8-character password
with a large dictionary would take days to weeks.

**Why not cost 14 or 16?** Signup and login calls `bcrypt.hash` and `bcrypt.compare`. With cost
12, signup takes ~350ms — acceptable for a one-time operation. With cost 14, it takes 1-2 seconds
— noticeably slow for the user and blocks the Node.js event loop for that duration (bcrypt's
internal computation is CPU-bound, partially synchronous despite the async API).

**`await bcrypt.hash(...)`** — `bcrypt.hash` returns a Promise. It uses Node's `worker_threads`
under the hood to run the CPU-intensive hash on a thread pool worker, preventing the main event
loop from blocking. This is crucial — without it, signup would freeze the server for 350ms,
blocking all other requests.

### `prisma.user.create` with explicit `select`

```typescript
const user = await prisma.user.create({
  data: { name, email, passwordHash },
  select: { id: true, name: true, email: true },
});
```

**Why `select` here?** Without `select`, Prisma returns ALL columns — including `passwordHash`.
We never want to accidentally include `passwordHash` in a response. By explicitly selecting `{ id,
name, email }`, we ensure the response object cannot contain the hash even if we accidentally
pass it to `res.json()` directly.

This is a defense-in-depth pattern: the response format is enforced at the DB query level, not
just in the controller's response serialization.

### `issueToken(userId, name)` — JWT structure

```typescript
function issueToken(userId: bigint, name: string): string {
  return jwt.sign({ sub: userId.toString(), name }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}
```

**`sub: userId.toString()`** — `sub` is the standard JWT claim for subject (the entity the token
refers to). We use the user's ID as `sub`. Storing as a string prevents the `bigint` JSON
serialization issue (JWT's JSON payload would throw on bigint).

**`name`** — stored in the JWT payload so the frontend can display the user's name without
making an additional `/auth/me` API call after login. The name is not security-critical
(changing your name doesn't grant you new permissions), so caching it in the JWT is safe.

**`expiresIn: env.JWT_EXPIRES_IN`** — typically `'7d'` (7 days). JWTs are stateless — there's
no server-side session table. Expiry is the only mechanism to revoke tokens. A 7-day expiry means:
- If a user's device is stolen, the attacker has 7 days before the token expires.
- If you want to force-logout a user, you'd need to add a token blacklist (not implemented here).

**`as jwt.SignOptions`** — TypeScript type cast needed because `jwt.SignOptions` has precise
typing that doesn't infer well from the object literal. The cast is safe.

### Login — timing attack prevention

```typescript
const user = await prisma.user.findUnique({ where: { email } });
if (!user) {
  throw createError('No account found with this email address', 401);
}

const valid = await bcrypt.compare(password, user.passwordHash);
if (!valid) {
  throw createError('Incorrect password. Please try again.', 401);
}
```

**This has a subtle timing attack.** The login handler returns different messages and spends
different amounts of time for "no user found" vs "wrong password":
- No user: ~5ms (single DB lookup, no bcrypt)
- Wrong password: ~350ms (DB lookup + bcrypt.compare)

An attacker can measure response times to determine if an email is registered. If the response
comes back in ~5ms, the email doesn't exist. If it takes ~350ms, the email exists.

**Proper fix (not implemented):** Call `bcrypt.compare(password, DUMMY_HASH)` even when the
user doesn't exist, so both paths take ~350ms. This is a known limitation — a future improvement
would be to add this constant-time path.

**Why the different error messages despite this attack?** The messages are user-facing — "No
account found" helps the user understand they need to sign up, while "Incorrect password" helps
them know they have the right email. In practice, email enumeration via timing requires many
requests and careful statistical analysis — it's not trivial to exploit. The current design
prioritizes UX over the theoretical timing vulnerability.

### `me` and `updateMe` — the authenticated profile endpoints

```typescript
export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    res.json({ id: user.id.toString(), name: user.name, email: user.email, createdAt: user.createdAt });
  } catch (err) {
    next(err);
  }
}
```

**`findUniqueOrThrow`** — if `userId` from the JWT somehow refers to a deleted user, this throws
a Prisma error that propagates to the error handler as a 500. Using `findUnique` (which returns
null) would require an explicit null check and `createError('User not found', 404)`. The `OrThrow`
variant handles the error case automatically with less code.

**Manual `id: user.id.toString()`** — note this endpoint doesn't use `serializeBigInt()`. It
manually converts `user.id.toString()` in the response object literal. Both approaches are
correct — this one is explicit about what fields are included. `serializeBigInt` would also work
but is more "magic" (converts all bigints recursively, including ones you might not want).

---

## 7. `services/zap-validation.service.ts` — Zap Step Invariant Enforcement

**File:** `apps/app-api/src/services/zap-validation.service.ts`

This is a pure function (no side effects, no DB calls) that validates the structural integrity
of a zap's step array before any DB writes.

### Why a dedicated service and not inline validation?

The same validation logic runs in three places:
1. `createZap` — validate the initial step set on creation
2. `addStep` — validate the new step set (existing + new step) when a step is added
3. (implicitly) the sequential executor assumes valid structure

By extracting to `validateZapSteps`, we have a single authoritative implementation. If a new
rule is added (e.g., "maximum 20 steps per zap"), it's added in one place and automatically
applies to all three call sites.

### Rule 1: No duplicate positions

```typescript
const positions = steps.map((s) => s.position);
const uniquePositions = new Set(positions);
if (uniquePositions.size !== positions.length) {
  throw createError('Duplicate step positions are not allowed', 400);
}
```

`Set` eliminates duplicates — if `positions = [0, 1, 1, 2]`, then `uniquePositions = {0, 1, 2}`
with size 3, but `positions.length = 4`. The mismatch `3 !== 4` detects the duplicate.

**Why does this matter for execution?** The sequential executor finds the next step with
`steps.find(s => s.position === currentPosition)`. If two steps have `position = 1`, `find`
returns only the first one. The second is silently skipped. The zap would execute incorrectly
with no error message. The validation prevents this silent corruption.

### Rule 2: Contiguous positions starting at 0

```typescript
const sorted = [...positions].sort((a, b) => a - b);
for (let i = 0; i < sorted.length; i++) {
  if (sorted[i] !== i) {
    throw createError(
      `Step positions must be contiguous starting at 0. Found gap at position ${i}`,
      400,
    );
  }
}
```

`[...positions].sort((a, b) => a - b)` — creates a sorted copy (the `...` spread prevents
mutation of the original array). The default `.sort()` sorts lexicographically (`[1, 10, 2]`
→ `[1, 10, 2]` — wrong). The comparator `(a, b) => a - b` sorts numerically.

After sorting, `sorted[i]` should equal `i` for all `i`. If `sorted = [0, 2, 3]`, then
`sorted[1] = 2 ≠ 1` → gap detected at position 1.

**Why contiguous?** The sequential executor advances `currentPosition++` after each step. If
there's a gap at position 1 (steps at 0, 2, 3), the executor increments to 1, finds no step,
and calls `markCompleted()` — thinking the run is done. Positions 2 and 3 are never executed.
Contiguous positions prevent this silent truncation.

### Rule 3: Exactly one trigger at position 0

```typescript
const triggers = steps.filter((s) => s.stepType === 'trigger');
if (triggers.length !== 1) {
  throw createError('A zap must have exactly one trigger step', 400);
}
if (triggers[0].position !== 0) {
  throw createError('The trigger step must be at position 0', 400);
}
```

**Why exactly one trigger?** A zap is "when X, do Y." X is the trigger. Multiple triggers would
mean "when X or when Z, do Y" — a different semantic that isn't supported. Zero triggers means
the zap can never start.

**Why must trigger be at position 0?** The sequential executor handles position 0 as a special
case (trigger step — no action, just records completion and aliases the payload). If a trigger
were at position 2, the executor would try to execute positions 0 and 1 as actions before the
trigger — conceptually impossible (you can't execute actions before the event that triggers them).

### Rule 4: Step type consistency

```typescript
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
```

These rules prevent type confusion at the DB level. A trigger step with `availableActionId` set
would confuse the worker's routing logic. An action step with `availableTriggerId` set would
confuse the webhook routing in `hooks-api`. The data model enforces semantics through validation.

---

## 8. `services/connection-ownership.service.ts` — IDOR Prevention

**File:** `apps/app-api/src/services/connection-ownership.service.ts`

```typescript
/**
 * Asserts that a connection belongs to the given user.
 * This is the real security boundary — not enforceable via FK because it's a
 * cross-row check (connection.userId == zap.userId).
 * Must be called on every write that associates a connection with a zap step.
 */
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

**The comment in the code is the most important part:** "not enforceable via FK because it's a
cross-row check." Let's explain this precisely.

PostgreSQL foreign keys enforce: "this value must exist in the referenced table." For example:
`zap_steps.connection_id REFERENCES connections(id)` ensures every `connection_id` in
`zap_steps` points to a real `connections` row. It does NOT check that `connections.user_id`
matches `zaps.user_id`.

**The IDOR scenario:**
```
User A has connection ID 50 (their Slack workspace)
User B knows connection ID 50 (guessed it, or got it through another exploit)
User B creates a zap: POST /zaps { steps: [{ connectionId: "50" }] }
Without assertConnectionOwnership: Zap is created using User A's Slack connection!
User B's zap now executes as User A on Slack.
```

`assertConnectionOwnership` prevents this by checking `connection.userId === userId`. If User B
(userId = 99) tries to use connection 50 (which belongs to userId = 42), the check fires and
returns 403.

**`select: { userId: true }` only** — we only need `userId` to do the ownership check. Selecting
only `userId` avoids loading unnecessary data (encrypted tokens, externalAccountId, etc.) that
we don't need for this security check.

**Called in three places:**
1. `createZap` — for each step with a `connectionId`
2. `addStep` — when adding a step with a `connectionId`
3. `updateStep` — when changing a step's `connectionId`

Any write path that associates a `connectionId` with a step MUST call this function. Missing
this call in any one path is a security vulnerability.

---

## 9. `controllers/connection.controller.ts` — OAuth & API Key Connections

**File:** `apps/app-api/src/controllers/connection.controller.ts`

### `listConnections` — credential concealment pattern

```typescript
const connections = await prisma.connection.findMany({
  where: { userId },
  select: {
    id: true,
    connectorId: true,
    label: true,
    externalAccountId: true,
    expiresAt: true,
    createdAt: true,
    connector: { select: { name: true, imageUrl: true, authType: true } },
  },
});
```

Notice what is NOT in the `select`:
- `accessToken` — encrypted OAuth access token
- `refreshToken` — encrypted OAuth refresh token
- `apiKey` — encrypted API key
- `apiSecret` — encrypted API secret

These are credentials. They should never be sent over the API, even to the owner. A user who
wants to "see their credentials" can do so in the provider's dashboard. Our API never exposes
them. If the response accidentally included `accessToken: "U2FsdGVkX1..."` (the encrypted token),
and if the encryption were ever broken, all credentials would be exposed in one response.

### `startOAuth` — the OAuth authorization URL

```typescript
export async function startOAuth(req, res, next): Promise<void> {
  const { connectorId } = z.object({ connectorId: z.string() }).parse(req.body);

  const connector = await prisma.connector.findUnique({ where: { id: connectorId } });
  if (!connector || connector.authType !== 'oauth') {
    throw createError('Connector not found or does not use OAuth', 400);
  }

  const authUrl = buildAuthUrl(connectorId, userId.toString());
  res.json({ authUrl });
}
```

**The OAuth flow start:** The frontend calls `POST /connections/oauth/start` with
`{ connectorId: 'slack' }`. The server builds an authorization URL pointing to Slack's OAuth
server and returns it to the frontend. The frontend redirects the browser to this URL.

`buildAuthUrl(connectorId, userId.toString())` — the `userId` is embedded in the OAuth `state`
parameter (as a HMAC-signed value — see `verifyOAuthState` below). This is how the callback
handler knows which Zappy user is completing the OAuth flow.

**Why not redirect directly?** The frontend could construct the authorization URL itself using
public client IDs. But:
1. The `state` parameter contains an HMAC signature that requires the server's secret key.
2. Centralizing URL construction avoids duplicating OAuth config (scope lists, redirect URIs)
   in the frontend.

### `oauthCallback` — the OAuth callback and CSRF prevention

```typescript
export async function oauthCallback(req, res, next): Promise<void> {
  const { code, state } = req.query as { code: string; state: string };
  if (!code || !state) throw createError('Missing code or state', 400);

  // SECURITY: verify HMAC signature on state to prevent CSRF (TASK-2.1)
  const { connectorId, userId } = verifyOAuthState(state);

  const tokens = await exchangeCode(connectorId, code);
  ...
}
```

**The `state` parameter and CSRF attack:** Without state verification, an attacker could craft a
malicious URL like:
```
https://zappy.com/connections/oauth/callback?code=ATTACKER_CODE&connectorId=slack
```

If a logged-in Zappy user clicks this URL, the callback handler would exchange `ATTACKER_CODE`
for tokens, but whose account do these tokens go into? Without the `state` carrying the user ID,
the handler has no way to know.

**The HMAC state pattern:**
1. `buildAuthUrl` generates: `state = base64(json { connectorId, userId }) + "." + HMAC(secret, json)`
2. The authorization URL sent to the provider includes this `state`
3. The provider echoes `state` back in the callback URL
4. `verifyOAuthState` recomputes the HMAC and verifies it matches
5. Only if valid does it extract `userId` from the state

An attacker cannot forge a valid `state` without knowing the HMAC secret. This prevents CSRF on
the OAuth callback endpoint.

### `oauthCallback` — the upsert semantics

```typescript
await prisma.connection.upsert({
  where: {
    userId_connectorId_externalAccountId: {
      userId: BigInt(userId),
      connectorId,
      externalAccountId: tokens.externalAccountId,
    },
  },
  create: { ... },
  update: {
    label,
    accessToken: encrypt(tokens.accessToken),
    refreshToken: encrypt(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
  },
});
```

**Why `upsert` and not `create`?** A user might re-connect the same Slack workspace twice (e.g.,
their access token was revoked and they want to reconnect). Without upsert, `create` would throw
a unique constraint violation (`unique(userId, connectorId, externalAccountId)`).

With upsert: if the connection already exists for this `(userId, connectorId, externalAccountId)`
combination, we update the tokens. The user gets fresh tokens without creating a duplicate
connection entry. Their existing zaps (which reference this `connectionId`) continue to work with
the new tokens.

**`encrypt(tokens.accessToken)`** — encrypts the fresh OAuth token before storing. AES-256-GCM
as described in DD3 §14. The encrypted token is stored in the DB; the plaintext is never
persisted.

**`res.redirect(...)`** — the callback is called by the OAuth provider's browser redirect. The
browser is on `https://slack.com/...` and the provider redirects to Zappy's callback URL. After
successful connection, we redirect the browser back to the Zappy dashboard. This completes the
browser-based OAuth flow.

### `connectApiKey` — the API key connection flow

```typescript
const connection = await prisma.connection.create({
  data: {
    userId,
    connectorId: body.connectorId,
    label: body.label,
    externalAccountId: 'default',
    apiKey: encrypt(body.apiKey),
    apiSecret: body.apiSecret ? encrypt(body.apiSecret) : null,
  },
  select: { id: true, connectorId: true, label: true, createdAt: true },
});
```

**`externalAccountId: 'default'`** — for API key connections, there's no "external account"
concept (unlike OAuth where `externalAccountId` is the Slack workspace ID or GitHub user ID).
We use the literal string `'default'`. This ensures the `unique(userId, connectorId,
externalAccountId)` constraint doesn't prevent a user from having multiple GitHub PAT connections
(e.g., for different organizations). Each would be `externalAccountId: 'default'` which would
conflict. This is a design limitation — API key connections don't support multiple instances per
connector per user.

**`select` without credentials** — same pattern as `listConnections`. The `apiKey` and
`apiSecret` are never returned in the response, even in the create response.

---

## 10. `controllers/connectors.controller.ts` — The Global Catalog API

**File:** `apps/app-api/src/controllers/connectors.controller.ts`

```typescript
export async function listConnectors(_req: Request, res: Response, next: NextFunction) {
  const connectors = await prisma.connector.findMany({
    select: {
      id: true,
      name: true,
      imageUrl: true,
      authType: true,
      supportsIdempotencyKey: true,
    },
    orderBy: { name: 'asc' },
  });
  res.json(connectors);
}
```

**No `authMiddleware` on `GET /connectors`?** The connectors catalog is public — it lists
available integrations (Slack, GitHub, Razorpay). There's no sensitive information in the catalog.
Making it public avoids requiring users to log in before they can see which connectors are
available. This is the "browse before you buy" UX pattern.

**`supportsIdempotencyKey`** — included in the response so the frontend can display "supports
safe retry" badges on connectors. This field maps directly to the adapter's
`supportsIdempotencyKey` boolean documented in DD4 §8.

### `getConnectorTriggers` and `getConnectorActions`

```typescript
export async function getConnectorTriggers(req, res, next) {
  const triggers = await prisma.availableTrigger.findMany({
    where: { connectorId: req.params.id },
    select: { id: true, name: true, payloadSchema: true },
  });
  res.json(triggers);
}
```

**`payloadSchema`** — a JSON Schema describing the shape of the webhook payload for this trigger.
The frontend uses this to render the template field mapping UI (e.g., "the GitHub push trigger
has fields: `ref`, `commits`, `pusher.name`, `pusher.email`"). Users pick which payload fields
to map into their action configs.

**`inputSchema`** in `getConnectorActions` — a JSON Schema describing the inputs required for
an action (e.g., Slack's `send-message` requires `channel` and `text`). The frontend renders
a form based on this schema, and the worker uses this schema for AJV validation (DD3 §9).

---

## 11. `controllers/runs.controller.ts` — Execution History API

**File:** `apps/app-api/src/controllers/runs.controller.ts`

### `listRunsForZap` — paginated run history

```typescript
const rawPage = Array.isArray(req.query.page) ? '1' : String(req.query.page ?? '1');
const rawLimit = Array.isArray(req.query.limit) ? '20' : String(req.query.limit ?? '20');
const page = parseInt(rawPage, 10) || 1;
const limit = Math.min(parseInt(rawLimit, 10) || 20, 100);
```

**`Array.isArray(req.query.page)`** — Express query params can be arrays. If the URL is
`/runs?page=1&page=2`, Express sets `req.query.page = ['1', '2']`. An array can't be parsed as
an integer, so we default to `'1'` for array values.

**`parseInt(rawPage, 10) || 1`** — `parseInt('abc', 10)` returns `NaN`. `NaN || 1` evaluates to
`1` because `NaN` is falsy. This handles any garbage in the query param.

**`Math.min(limit, 100)`** — caps the limit at 100 rows per page regardless of what the client
requests. Without this cap, a client could request `limit=10000`, causing a massive DB scan that
loads 10,000 run records into memory.

### Offset-based pagination (`skip`/`take`)

```typescript
prisma.zapRun.findMany({
  where: { zapId },
  orderBy: { startedAt: 'desc' },
  skip: (page - 1) * limit,
  take: limit,
  ...
})
```

**Offset pagination vs cursor pagination:**

**Offset:** `skip = (page - 1) * limit`. Simple, human-friendly ("go to page 3"). The downside:
if a new run is inserted while the user is browsing, pagination shifts — page 2's first item
becomes page 1's last item. Run history is append-only (no runs are deleted while browsing), so
this race condition rarely matters in practice.

**Cursor:** `cursor = { id: lastId }`. Stable even with new inserts. More complex to implement,
harder to jump to arbitrary pages ("show me page 50"). Not necessary for run history where users
browse forward chronologically.

For run history, offset pagination is the right trade-off: simple implementation, good enough
correctness.

### Parallel count + data fetch

```typescript
const [runs, total] = await Promise.all([
  prisma.zapRun.findMany({ ... }),
  prisma.zapRun.count({ where: { zapId } }),
]);
```

**`Promise.all`** — fires both queries simultaneously. `findMany` returns the page of runs;
`count` returns the total for the pagination UI ("Showing 21-40 of 150 runs"). Without
`Promise.all`, these would run sequentially — two DB round-trips instead of one parallel pair.

**Why return `total`?** The frontend needs it to render page navigation ("Page 3 of 8"). Without
`total`, the frontend can only show "previous/next" and can't calculate the page count.

### `getRun` — full run detail with step hierarchy

```typescript
const run = await prisma.zapRun.findFirst({
  where: {
    id: runId,
    zap: { userId },   // Ownership check via relation filter
  },
  include: {
    zapRunSteps: {
      orderBy: { executedAt: 'asc' },
      include: {
        zapStep: {
          include: {
            availableAction: { select: { name: true, connectorId: true } },
            availableTrigger: { select: { name: true, connectorId: true } },
          },
        },
      },
    },
  },
});
```

**`where: { zap: { userId } }`** — the run's ownership check is done via the Prisma relation
filter. Instead of:
```typescript
const zap = await prisma.zap.findFirst({ where: { id: run.zapId, userId } });
if (!zap) throw 403;
const run = await prisma.zapRun.findFirst({ where: { id: runId } });
```
(two queries), we do it in one query by navigating the relation: "find a run where its zap's
userId matches." Prisma translates this to a JOIN. One round-trip instead of two.

**The deep include chain:** `zapRunSteps → zapStep → availableAction/availableTrigger`. This
produces the full execution timeline:
```json
{
  "id": "1234",
  "status": "completed",
  "zapRunSteps": [
    {
      "status": "completed",
      "executedAt": "2024-01-15T10:00:00Z",
      "output": { "ok": true, "ts": "1728738400.123" },
      "zapStep": {
        "stepType": "action",
        "position": 1,
        "availableAction": { "name": "Send Message", "connectorId": "slack" }
      }
    }
  ]
}
```

The frontend renders this as an execution timeline: "Step 1 (trigger) ✓ → Step 2 (Slack: Send
Message) ✓ with output: message sent at 10:00:00"

**`serializeBigInt(run)`** — the run includes nested objects with bigint IDs at multiple levels
(`run.id`, `run.zapRunSteps[].id`, `run.zapRunSteps[].zapStep.id`). `serializeBigInt` handles all
of them recursively in a single call.

---

## 12. The Complete Request Lifecycle: One Request, Start to Finish

Tracing a single request: `GET /zaps/42` by an authenticated user.

```
1. HTTP Request arrives at app-api container on port 3001:
   GET /zaps/42
   Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OSIsIm5hbWUiOiJBbGljZSJ9.xxx

2. helmet() runs:
   Adds security headers:
     X-Content-Type-Options: nosniff
     X-Frame-Options: DENY
     X-XSS-Protection: 0
     ... (13 headers total)

3. cors() runs:
   Request origin = "http://localhost:3000"
   env.WEB_APP_URL = "http://localhost:3000"
   Adds: Access-Control-Allow-Origin: http://localhost:3000
         Access-Control-Allow-Credentials: true

4. express.json() runs:
   Method = GET, no body. Skips body parsing. next().

5. requestLogger runs:
   Path !== '/health'. Captures start = Date.now().
   Registers res.on('finish') listener. next().

6. globalLimiter runs:
   IP "192.168.1.1": count = 1, under 200/min. next().

7. app.listen routes to zapsRouter:
   Pattern /zaps/:id matches /zaps/42.

8. authMiddleware runs (applied in zaps.routes.ts):
   authHeader = "Bearer eyJhbGciOiJIUzI1NiJ9..."
   authHeader.startsWith('Bearer ') → true
   token = "eyJhbGciOiJIUzI1NiJ9..."
   jwt.verify(token, JWT_SECRET):
     → decoded payload = { sub: "99", name: "Alice", exp: 1728997200 }
     → exp > now → not expired
     → signature valid
   req.userId = BigInt("99") = 99n
   next()

9. getZap controller runs:
   userId = 99n
   zapId = BigInt("42") = 42n

   DB query: prisma.zap.findFirst({
     where: { id: 42n, userId: 99n },
     include: { steps: { select: { id, stepType, position, ... } } }
   })
   → Returns zap { id: 42n, name: "My First Zap", steps: [...] }
   → webhookSecret NOT in select → not in result

10. serializeBigInt(zap):
    { id: 42n, steps: [{ id: 7n, ... }] }
    → JSON.stringify with replacer
    → JSON.parse
    → { id: "42", steps: [{ id: "7", ... }] }

11. res.json(serialized):
    Calls JSON.stringify internally
    Sets Content-Type: application/json
    Sends 200 response body

12. res.on('finish') fires (from step 5):
    durationMs = Date.now() - start → 23ms
    statusCode = 200 → level = 'info'
    logger.info({ method: 'GET', path: '/zaps/42', status: 200, durationMs: 23, ip: '192.168.1.1' }, 'GET /zaps/42 200 23ms')

Total time: ~23ms (one DB query with JOIN)
```

---

*Continue to: [DD6 — Database Schema & Migrations, Line by Line](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD6_DATABASE_SCHEMA_AND_MIGRATIONS.md)*
