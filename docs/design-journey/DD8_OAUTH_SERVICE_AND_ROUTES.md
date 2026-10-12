# Deep Dive 8 — OAuth Service, Encryption Service & Route Architecture: Every Line Explained

> This chapter dissects the entire OAuth 2.0 implementation: how authorization URLs are built
> with HMAC-signed state parameters, how state verification prevents CSRF attacks, how the token
> exchange actually works (including Slack's unusual response shape), how credentials are stored
> encrypted at rest using AES-256-GCM, and how each router wire-frames its middleware chain.
> It also covers the detailed route-level design of all five Express routers in `app-api`.

---

## Table of Contents

1. [`encryption.service.ts` — AES-256-GCM Encrypt / Decrypt](#1-encryptionservicets--aes-256-gcm-encrypt--decrypt)
2. [`oauth.service.ts` — `getOAuthConfig`](#2-oauthservicets--getoauthconfig)
3. [`oauth.service.ts` — `buildAuthUrl`: The HMAC State Construction](#3-oauthservicets--buildauthurl-the-hmac-state-construction)
4. [`oauth.service.ts` — `verifyOAuthState`: CSRF Prevention in Detail](#4-oauthservicets--verifyoauthstate-csrf-prevention-in-detail)
5. [`oauth.service.ts` — `exchangeCode`: The Token Request](#5-oauthservicets--exchangecode-the-token-request)
6. [`oauth.service.ts` — `refreshAccessToken`: The Proactive Refresh](#6-oauthservicets--refreshaccesstoken-the-proactive-refresh)
7. [Route Architecture: Five Routers, Their Middleware Chains](#7-route-architecture-five-routers-their-middleware-chains)
8. [`auth.routes.ts` — The Brute-Force Rate Limiter](#8-authroutests--the-brute-force-rate-limiter)
9. [`connections.routes.ts` — The Special Case of `/oauth/callback`](#9-connectionsroutests--the-special-case-of-oauthcallback)
10. [`zaps.routes.ts` — Router-Level vs Handler-Level Auth](#10-zapsroutests--router-level-vs-handler-level-auth)
11. [The OAuth End-to-End Flow: One Narrative](#11-the-oauth-end-to-end-flow-one-narrative)

---

## 1. `encryption.service.ts` — AES-256-GCM Encrypt / Decrypt

**File:** `apps/app-api/src/services/encryption.service.ts`

This file is the single source of truth for credential encryption in `app-api`. The worker has
an identical implementation (DD3 §14). Both must use the same key and format so that tokens
encrypted by `app-api` can be decrypted by the worker.

```typescript
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96 bits — recommended for GCM
const TAG_LENGTH = 16;  // 128 bits — AES-GCM default auth tag

function getKey(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
}
```

### Why `getKey()` is a function, not a constant

```typescript
// Would also work but less safe:
const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

// This is what we use:
function getKey(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
}
```

If `ENCRYPTION_KEY` is stored as a module-level constant, the key bytes live in memory for the
entire process lifetime. If a memory dump is taken (e.g., in a crash), the key is visible. By
calling `getKey()` on demand, the key buffer is allocated, used, and then eligible for garbage
collection. In practice the difference is minor (GC is non-deterministic), but it's a better
practice — especially for future evolution toward key rotation where the key itself might change.

### `encrypt(plaintext: string): string`

```typescript
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);              // 12 random bytes
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();                       // 16 bytes

  // Format: [12B iv][16B tag][ciphertext]
  const result = Buffer.concat([iv, tag, encrypted]);
  return result.toString('base64');
}
```

**The `cipher.update()` + `cipher.final()` pattern:** In Node's crypto API, `cipher.update()`
processes input data and may return some encrypted output. `cipher.final()` flushes the last
block and signals end of encryption. For AES-GCM with short strings, all output often comes from
`final()`. Both are called regardless and the results concatenated.

**`cipher.getAuthTag()`** — MUST be called AFTER `cipher.final()`. Before `final()`, the auth
tag is not yet computed (GCM hashes the ciphertext as it encrypts). Calling `getAuthTag()`
before `final()` throws.

**Why IV before tag before ciphertext?** The decoder needs the IV and tag first to set up
decryption. Since IV and tag are fixed lengths (12 and 16 bytes), they can be cleanly sliced:
```
data[0..12]   → iv
data[12..28]  → tag
data[28..]    → ciphertext
```
If the order were `ciphertext + iv + tag`, you'd need to know the ciphertext length before
parsing, which requires storing the length separately.

**Why `base64` not `hex`?** Both work for storage in PostgreSQL `TEXT` columns. Base64 produces
~33% more characters than the raw bytes, but ~25% fewer characters than hex. For a 256-byte
ciphertext: base64 = ~344 chars, hex = ~512 chars. Smaller is better for DB storage.

### `decrypt(encoded: string): string`

```typescript
export function decrypt(encoded: string): string {
  const data = Buffer.from(encoded, 'base64');

  const iv         = data.subarray(0, IV_LENGTH);
  const tag        = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);

  return (
    decipher.update(ciphertext).toString('utf8') +
    decipher.final('utf8')
  );
}
```

**`decipher.setAuthTag(tag)`** — MUST be called BEFORE `decipher.update()`. This pre-loads the
expected authentication tag. When `decipher.final()` is called, Node recomputes the auth tag from
the decrypted data and compares it to the one set here. If they don't match, `final()` throws:

```
Error [ERR_CRYPTO_INVALID_AUTH_TAG]: Unsupported state or unable to authenticate data
```

This error means either:
1. The ciphertext was tampered with (the DB value was corrupted or modified)
2. The wrong `ENCRYPTION_KEY` was used (e.g., key was rotated without re-encrypting old values)
3. The IV or tag was corrupted (the base64 string is malformed)

**`data.subarray()`** — creates a view into the buffer without copying. More efficient than
`data.slice()` for large buffers. Both work correctly here since the buffer is small (~350 bytes
for a typical OAuth token).

**Authentication failure is a 500** — if `decrypt()` throws, the error propagates to the step-
runner's `catch` block, which marks the step `failed` with `errorCode: 'DECRYPTION_ERROR'`. The
operator's Sentry alert fires with the full stack trace.

---

## 2. `oauth.service.ts` — `getOAuthConfig`

**File:** `apps/app-api/src/services/oauth.service.ts`

```typescript
export function getOAuthConfig(connectorId: string): ConnectorOAuthConfig {
  switch (connectorId) {
    case 'slack':
      return {
        authUrl:      'https://slack.com/oauth/v2/authorize',
        tokenUrl:     'https://slack.com/api/oauth.v2.access',
        clientId:     env.SLACK_CLIENT_ID ?? '',
        clientSecret: env.SLACK_CLIENT_SECRET ?? '',
        redirectUri:  env.SLACK_REDIRECT_URI ?? '',
        scopes:       ['chat:write', 'channels:read'],
      };
    default:
      throw new Error(`No OAuth config for connector: ${connectorId}`);
  }
}
```

### Why a switch and not a DB lookup?

OAuth config contains `clientSecret` — a sensitive credential. Storing it in the DB would mean:
- All admins with DB access can see all OAuth client secrets
- DB compromise = all integrations are compromised

By reading from environment variables (`env.SLACK_CLIENT_ID`), the secrets are stored in the
deployment environment (Docker secrets, Kubernetes secrets, or cloud secret managers). They're
never written to any persistent storage that could be queried.

**The `?? ''` fallback:** `env.SLACK_CLIENT_ID ?? ''` — if the env var is not set, defaults to
empty string instead of throwing. This allows the service to start even if Slack credentials
aren't configured (some deployments may only need Razorpay or GitHub). When a user tries to
connect Slack without credentials set, `exchangeCode` will fail with an OAuth error from Slack
(`invalid_client`), which surfaces as a 502 to the user.

**Hardcoded `scopes`** — the scopes (`chat:write`, `channels:read`) are hardcoded in code, not
fetched from the DB's `connectors.scopes` column. This creates a duplication between the seed
data and the code. The rationale: scopes define what API calls the app can make — this is a
security boundary that should be controlled by engineers in code review, not in DB data that an
admin could change without a code review.

### The `ConnectorOAuthConfig` interface

```typescript
interface ConnectorOAuthConfig {
  authUrl:      string;   // OAuth provider's authorization endpoint
  tokenUrl:     string;   // OAuth provider's token exchange endpoint
  clientId:     string;   // App's client ID registered with the provider
  clientSecret: string;   // App's client secret (never leaves the server)
  redirectUri:  string;   // URL provider sends the user back to after auth
  scopes:       string[]; // Permissions requested from the provider
}
```

**Why `redirectUri` in config and not hardcoded?** `redirectUri` must match exactly what's
registered in the OAuth provider's dashboard. In development, it might be
`http://localhost:3001/connections/oauth/callback`. In production, it's the deployed URL. Storing
as env var allows the same code to work in both environments.

---

## 3. `oauth.service.ts` — `buildAuthUrl`: The HMAC State Construction

```typescript
export function buildAuthUrl(connectorId: string, userId: string): string {
  const config = getOAuthConfig(connectorId);
  const payload = Buffer.from(
    JSON.stringify({ connectorId, userId })
  ).toString('base64url');
  const hmac = crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(payload)
    .digest('hex');
  const state = `${payload}.${hmac}`;

  const params = new URLSearchParams({
    client_id:     config.clientId,
    redirect_uri:  config.redirectUri,
    scope:         config.scopes.join(' '),
    response_type: 'code',
    state,
  });
  return `${config.authUrl}?${params}`;
}
```

### The state parameter — line by line

**Line 1: `JSON.stringify({ connectorId, userId })`**
```json
{"connectorId":"slack","userId":"42"}
```
This is the payload we need to carry through the OAuth flow. When Slack calls our callback, we
need to know: (a) which connector this is for, (b) which Zappy user is connecting.

**Line 2: `.toString('base64url')`**
`base64url` (not regular `base64`) uses URL-safe characters (`-` and `_` instead of `+` and `/`).
This is important because the `state` parameter is included in a URL. Regular base64 uses `+`
and `/` which have special meanings in URLs and would be double-encoded.

```
base64:    eyJjb25uZWN0b3JJZCI6InNsYWNrIiwidXNlcklkIjoiNDIifQ==
base64url: eyJjb25uZWN0b3JJZCI6InNsYWNrIiwidXNlcklkIjoiNDIifQ
```

Note: base64url also omits the trailing `=` padding, which further simplifies URL inclusion.

**Line 3: `crypto.createHmac('sha256', env.JWT_SECRET).update(payload).digest('hex')`**

HMAC-SHA256 of the base64url payload. Using `env.JWT_SECRET` (reusing the JWT secret for the
HMAC — acceptable since both are symmetric secrets used for authentication).

The HMAC signs the ENTIRE base64url payload. If an attacker modifies the payload (e.g., changes
`userId` from "42" to "99"), the HMAC verification will fail because the modified payload
produces a different HMAC.

**Line 4: `const state = \`${payload}.${hmac}\``**

Format: `base64url_payload.hex_hmac`
Example: `eyJjb25uZWN0b3...Q.a1b2c3d4e5f6...`

The `.` separator allows `verifyOAuthState` to split at `lastIndexOf('.')`.

**Why `.lastIndexOf` and not `.indexOf`?** Base64url can contain `.` in theory (though in
practice our payload doesn't). Using `lastIndexOf` ensures we always split at the LAST dot —
correctly separating the `base64url_payload` (which might contain dots) from the `hex_hmac`
(which is pure hex, never containing dots).

### The URLSearchParams construction

```typescript
const params = new URLSearchParams({
  client_id:     config.clientId,
  redirect_uri:  config.redirectUri,
  scope:         config.scopes.join(' '),
  response_type: 'code',
  state,
});
return `${config.authUrl}?${params}`;
```

**`config.scopes.join(' ')`** — OAuth scopes are space-separated in URLs
(`scope=chat:write channels:read`). URLSearchParams handles URL encoding, so the space becomes
`%20` in the actual URL.

**`response_type: 'code'`** — specifies the Authorization Code flow (not Implicit flow). The
provider returns an authorization `code` (short-lived, single-use) which we exchange for tokens
server-side. The alternative (Implicit flow) returns tokens directly in the URL fragment — insecure
because the token is visible in browser history and logs.

The final URL looks like:
```
https://slack.com/oauth/v2/authorize
  ?client_id=123456789.987654321
  &redirect_uri=https://app.zappy.com/connections/oauth/callback
  &scope=chat:write%20channels:read
  &response_type=code
  &state=eyJjb25u...Q.a1b2c3d4
```

---

## 4. `oauth.service.ts` — `verifyOAuthState`: CSRF Prevention in Detail

```typescript
export function verifyOAuthState(state: string): { connectorId: string; userId: string } {
  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) throw new Error('Invalid OAuth state: missing signature');

  const payload      = state.slice(0, dotIndex);
  const receivedHmac = state.slice(dotIndex + 1);
  const expectedHmac = crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(payload)
    .digest('hex');

  if (!crypto.timingSafeEqual(
    Buffer.from(receivedHmac, 'hex'),
    Buffer.from(expectedHmac, 'hex'),
  )) {
    throw new Error('Invalid OAuth state: signature mismatch');
  }

  return JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8')
  ) as { connectorId: string; userId: string };
}
```

### `crypto.timingSafeEqual` — preventing timing attacks

**The timing attack on HMAC comparison:**
```typescript
// VULNERABLE — constant-time is NOT guaranteed:
if (receivedHmac !== expectedHmac) { throw ... }

// SAFE — constant-time comparison:
if (!crypto.timingSafeEqual(...)) { throw ... }
```

A naive `!==` string comparison stops as soon as it finds the first differing character. If an
attacker can measure the response time, they can learn:
- "The first character is wrong" (fast response → stopped at char 0)
- "The first 10 characters are right, char 11 is wrong" (slower response)

By measuring response times across thousands of requests with different state guesses, an attacker
can recover the expected HMAC one nibble at a time.

`timingSafeEqual` compares all bytes in constant time regardless of where the first difference is.
Same pattern used in DD1 §6 for HMAC webhook verification.

**Why compare `Buffer.from(receivedHmac, 'hex')`?** `timingSafeEqual` requires `Buffer` arguments
of equal length. Hex strings are twice the length of the actual bytes. Converting to `Buffer`
with `'hex'` encoding halves the length (64-char hex string → 32-byte Buffer). Both sides are
converted, so the comparison is still correct.

**If `receivedHmac` is not valid hex?** `Buffer.from('xyz', 'hex')` produces an empty Buffer
(Node silently discards invalid hex characters). Comparing an empty Buffer to a 32-byte Buffer
would normally throw because `timingSafeEqual` requires equal lengths. This IS a potential crash
path — a maliciously crafted state with a non-hex signature would throw from `timingSafeEqual`.
This is acceptable — the throw reaches the controller's catch block, which returns 400.

### Decode after verification

```typescript
return JSON.parse(
  Buffer.from(payload, 'base64url').toString('utf8')
) as { connectorId: string; userId: string };
```

The payload is decoded ONLY AFTER the HMAC is verified. This is the correct order. If we decoded
first and verified second, an attacker could provide a malformed payload that causes `JSON.parse`
to throw before HMAC verification runs — potentially leaking information about the parsing step.

"Verify then decode" is the standard pattern for signed tokens.

---

## 5. `oauth.service.ts` — `exchangeCode`: The Token Request

```typescript
export async function exchangeCode(connectorId: string, code: string): Promise<OAuthTokens> {
  const config = getOAuthConfig(connectorId);

  const response = await axios.post(
    config.tokenUrl,
    new URLSearchParams({
      client_id:     config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri:  config.redirectUri,
      grant_type:    'authorization_code',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const data = response.data;
  if (data.error) throw new Error(`OAuth error: ${data.error}`);

  // Slack-specific normalization
  const accessToken: string = data.access_token ?? data.authed_user?.access_token;
  const refreshToken: string = data.refresh_token ?? '';
  const externalAccountId: string = data.team?.id ?? data.authed_user?.id ?? 'default';
  const expiresIn: number | undefined = data.expires_in;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  return { accessToken, refreshToken, externalAccountId, expiresAt };
}
```

### The token request body

**`grant_type: 'authorization_code'`** — tells the provider we're exchanging an auth code for
tokens (not doing a refresh, which uses `grant_type: 'refresh_token'`).

**`redirect_uri` must match exactly** — providers validate that the `redirect_uri` in the token
request matches the one in the original authorization request. This prevents a provider from
being tricked into issuing tokens for a different redirect destination.

**`Content-Type: application/x-www-form-urlencoded`** — most OAuth providers (including Slack)
expect the token request body as URL-encoded form data, not JSON. `new URLSearchParams()`
produces `client_id=xxx&client_secret=yyy&code=zzz&...` as a string. axios with this body
and header correctly sends it as form data.

### Slack's unusual response shape

Slack's token endpoint returns a non-standard structure:
```json
{
  "ok": true,
  "access_token": "xoxb-...",         // Bot token
  "team": { "id": "T01234" },         // Workspace ID
  "authed_user": {
    "id": "U01234",                   // User who installed
    "access_token": "xoxp-..."        // User token (if user scopes requested)
  }
}
```

**`data.access_token ?? data.authed_user?.access_token`** — prefers the bot token
(`access_token` at top level) but falls back to the user token (`authed_user.access_token`).
For Zappy's "Send Message" action, the bot token is needed (not the user token).

**`data.team?.id ?? data.authed_user?.id ?? 'default'`** — the workspace ID (`team.id`) is the
external account identifier. It's what makes the unique constraint `(userId, connectorId,
externalAccountId)` work for Slack — a user can connect multiple Slack workspaces (each has a
different `team.id`).

**`refreshToken ?? ''`** — Slack does NOT return a refresh token for most OAuth scopes. The
access token doesn't expire for standard bot tokens. So `data.refresh_token` is `undefined` and
we default to an empty string. The DB's `auth_fields_match_type` CHECK constraint requires both
`access_token IS NOT NULL` AND `refresh_token IS NOT NULL`, so we store `''` (an empty encrypted
string) as the refresh token. This is a known limitation: for Slack, the "refresh token" is
meaningless, but the DB schema requires it.

**`expiresIn`** — seconds until the token expires. `null` for non-expiring tokens (Slack bots).
`expiresAt = new Date(Date.now() + expiresIn * 1000)` converts seconds to a timestamp.

### Error detection: `data.error`

OAuth errors don't always come with HTTP 4xx status codes. Slack returns HTTP 200 with:
```json
{ "ok": false, "error": "invalid_code" }
```

Without `if (data.error) throw ...`, the code would try to use an empty or undefined
`accessToken`, producing a cryptic error later. Checking `data.error` immediately catches
provider-level errors.

---

## 6. `oauth.service.ts` — `refreshAccessToken`: The Proactive Refresh

```typescript
export async function refreshAccessToken(connectionId: bigint): Promise<void> {
  const connection = await prisma.connection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { connector: true },
  });

  const config = getOAuthConfig(connection.connectorId);
  const refreshToken = decrypt(connection.refreshToken!);

  const response = await axios.post(
    config.tokenUrl,
    new URLSearchParams({
      client_id:     config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const data = response.data;
  if (data.error) throw new Error(`Token refresh failed: ${data.error}`);

  await prisma.connection.update({
    where: { id: connectionId },
    data: {
      accessToken: encrypt(data.access_token),
      ...(expiresAt && { expiresAt }),
    },
  });
}
```

This function is called from two places:
1. **Background cron job** (`refresh-expiring-tokens` every hour) — proactively refreshes tokens
   expiring within the next 60 minutes (DD4 §6)
2. **Worker's step-runner** — on `401 Unauthorized` response from a provider (DD3 §13)

### Why `connection.refreshToken!` — the non-null assertion

`connection.refreshToken` is `String | null` in the TypeScript type (because API key connections
have no refresh token). The `!` asserts "I know this is not null." This is safe because
`refreshAccessToken` is only called for connections that are OAuth type (`authType === 'oauth'`).
The caller checks this before calling — the function trusts its callers.

**A safer approach:** Add a guard:
```typescript
if (!connection.refreshToken) throw new Error('No refresh token available');
```
The current approach relies on correct callers. Both approaches are defensible; the guard version
is more robust but adds code for a case that should never happen if callers are correct.

### `...(expiresAt && { expiresAt })` — conditional object spread

If the provider doesn't return `expires_in` (no expiry, like Slack bots), `expiresAt` is `null`.
We don't want to set `expiresAt: null` in the DB (that would clear a previously set expiry).
The conditional spread `...(expiresAt && { expiresAt })` only includes `expiresAt` in the update
if it's truthy. `null && { expiresAt }` evaluates to `null` (falsy), so the spread is empty.
`new Date(...) && { expiresAt }` evaluates to `{ expiresAt }` (truthy Date object), so the
expiry IS updated.

---

## 7. Route Architecture: Five Routers, Their Middleware Chains

```
/auth        → authRouter       (public signup/login + auth-protected me)
/connectors  → connectorsRouter (fully public catalog)
/connections → connectionsRouter (mixed: callback public, rest auth-protected)
/zaps        → zapsRouter       (fully auth-protected via router-level middleware)
/runs        → runsRouter       (fully auth-protected via router-level middleware)
```

Express routers work like mini-apps. Each router has its own middleware stack and routes. When
`app.use('/zaps', zapsRouter)` runs, Express strips the `/zaps` prefix and passes the remaining
path to `zapsRouter`. So `GET /zaps/42` reaches `zapsRouter.get('/:id')`.

### Two patterns for applying `authMiddleware`

**Pattern 1: Router-level middleware** (used by `zaps.routes.ts` and `runs.routes.ts`)
```typescript
zapsRouter.use(authMiddleware);  // Applies to ALL routes in this router
zapsRouter.get('/:id', getZap); // No need to add authMiddleware here
```

**Pattern 2: Handler-level middleware** (used by `auth.routes.ts` and `connections.routes.ts`)
```typescript
authRouter.post('/signup', authLimiter, signup);   // No authMiddleware
authRouter.get('/me', authMiddleware, me);          // authMiddleware only here
```

**When to use which?**
- Use router-level when ALL routes in the router require auth (zaps, runs)
- Use handler-level when SOME routes are public and some are auth-protected (auth, connections)

---

## 8. `auth.routes.ts` — The Brute-Force Rate Limiter

```typescript
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  limit: 10,                   // 10 attempts per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please try again in 15 minutes.' },
});

authRouter.post('/signup', authLimiter, signup);
authRouter.post('/login', authLimiter, login);
authRouter.get('/me', authMiddleware, me);
authRouter.patch('/me', authMiddleware, updateMe);
```

### Why a second, tighter rate limiter?

The global limiter (`200/min`) protects against general flooding. The auth-specific limiter
(`10/15min`) is significantly tighter because auth endpoints are the most sensitive — they're the
gateway to the entire system.

**Math on brute-force:** A 8-character lowercase password has 26^8 ≈ 200 billion combinations.
With 10 attempts per 15 minutes, an attacker can try 10 passwords per 15 minutes = 40 per hour
= 960 per day per IP. At that rate, a fully random 8-char lowercase password takes 200B / 960 ≈
208 million days. Even a dictionary attack against a weak password is difficult at 10/15min.

**`standardHeaders: 'draft-7'`** — sends standardized RateLimit headers in responses:
```
RateLimit-Limit: 10
RateLimit-Remaining: 9
RateLimit-Reset: 1728740400
```
These headers allow the frontend to display "You have 3 login attempts remaining" without
needing to track attempts itself.

**`legacyHeaders: false`** — disables the old `X-RateLimit-*` headers (non-standard, legacy).
Only the standardized `RateLimit-*` headers are sent.

### `authRouter.patch('/me', authMiddleware, updateMe)`

The `updateMe` handler (not shown in full) accepts `{ name, email }` and updates the user's
profile. It requires `authMiddleware` because only the authenticated user can update their own
profile. It does NOT require the auth rate limiter — profile updates aren't security-sensitive
in the same way that login attempts are.

---

## 9. `connections.routes.ts` — The Special Case of `/oauth/callback`

```typescript
// /oauth/callback is a browser redirect from Slack/etc — no JWT token is
// sent, and none is needed: the HMAC-signed `state` param identifies the user.
connectionsRouter.get('/oauth/callback', oauthCallback);

// All other connection routes require a valid JWT.
connectionsRouter.get('/',             authMiddleware, listConnections);
connectionsRouter.post('/oauth/start', authMiddleware, startOAuth);
connectionsRouter.post('/api-key',     authMiddleware, connectApiKey);
connectionsRouter.delete('/:id',       authMiddleware, deleteConnection);
```

The comment on `/oauth/callback` is the most important part of this file. Let's unpack why
the callback endpoint is public:

**The OAuth callback flow:**
1. User (logged-in, has JWT) clicks "Connect Slack" on the frontend
2. Frontend calls `POST /connections/oauth/start` with JWT → gets auth URL
3. Frontend redirects browser to `https://slack.com/oauth/v2/authorize?state=...`
4. User grants permission on Slack's website
5. Slack's website redirects the user's browser to `https://zappy.com/connections/oauth/callback?code=xxx&state=yyy`

**Step 5 is the problem:** When the browser follows the redirect to `/connections/oauth/callback`,
it's a plain `GET` request initiated by Slack's server-side redirect. The browser carries no
JWT token (it doesn't know to add the `Authorization: Bearer` header — that's managed by the
frontend JavaScript, which isn't running at this point — the browser is just following a URL).

The callback endpoint can't require JWT auth because the token arrives with NO authorization
header. Instead, the `state` parameter (HMAC-signed as explained in §3) contains the `userId`.
This is the correct design — the HMAC signature on `state` is equivalent to authentication for
this specific endpoint.

**Security:** Without `authMiddleware` but WITH `verifyOAuthState`, the endpoint is still secure:
- Can a random person call `/oauth/callback` with a forged `code`? Yes, but without a valid
  `state`, `verifyOAuthState` rejects the request.
- Can an attacker forge a `state`? No, because they don't know `JWT_SECRET` used as the HMAC key.
- Can an attacker replay a legitimate `state`? Authorization codes are single-use — Slack rejects
  any code that's been exchanged. Replaying the same callback URL fails at `exchangeCode`.

---

## 10. `zaps.routes.ts` — Router-Level vs Handler-Level Auth

```typescript
zapsRouter.use(authMiddleware);   // Applied to ALL routes below

zapsRouter.get('/', listZaps);
zapsRouter.post('/', createZap);
zapsRouter.get('/:id', getZap);
zapsRouter.patch('/:id', updateZap);
zapsRouter.delete('/:id', deleteZap);

zapsRouter.post('/:id/steps', addStep);
zapsRouter.patch('/:id/steps/:stepId', updateStep);
zapsRouter.delete('/:id/steps/:stepId', deleteStep);

// Webhook secret — separate endpoint
zapsRouter.get('/:id/steps/:stepId/webhook-secret', getWebhookSecret);
```

**`zapsRouter.use(authMiddleware)` before all routes** — this is router-level middleware
registration. Express processes middleware and routes in registration order. Since `use()`
comes before all `get()`/`post()`/`patch()`/`delete()` calls, `authMiddleware` runs for ALL
requests to any route in this router.

**Why not global `app.use(authMiddleware)`?** Because public routes (`GET /connectors`,
`GET /connectors/:id/triggers`, `POST /auth/signup`) would be blocked by the global middleware.
Router-level gives us per-router control.

**The webhook secret at a dedicated endpoint:**
```typescript
zapsRouter.get('/:id/steps/:stepId/webhook-secret', getWebhookSecret);
```

The webhook secret is NEVER included in `GET /zaps/:id`. It's exposed only via this dedicated
endpoint. This design means:
1. A frontend bug that logs all `GET /zaps/:id` responses doesn't accidentally log the webhook
   secret
2. The secret is only fetched when the user explicitly requests it (the "Setup" screen in the UI)
3. Prisma's `select` in `getZap` explicitly excludes `webhookSecret` — not an accident

---

## 11. The OAuth End-to-End Flow: One Narrative

Here is the complete OAuth flow for "User connects their Slack workspace to Zappy":

```
T+0  User clicks "Connect Slack" in the Zappy frontend.

T+1  Frontend: POST /connections/oauth/start
       Body: { connectorId: "slack" }
       Headers: Authorization: Bearer <JWT>

T+2  authMiddleware verifies JWT → userId = 42n
     startOAuth controller:
       getOAuthConfig('slack') → { authUrl, tokenUrl, clientId, ... }
       payload = base64url({ connectorId: "slack", userId: "42" })
              = "eyJjb25uZWN0b3JJZCI6InNsYWNrIiwidXNlcklkIjoiNDIifQ"
       hmac   = HMAC-SHA256(payload, JWT_SECRET) = "a1b2c3...f9"
       state  = "eyJjb25u...Q.a1b2c3...f9"
       authUrl = "https://slack.com/oauth/v2/authorize?client_id=123&...&state=eyJjb25u...Q.a1b2c3...f9"
     Response: { authUrl: "https://slack.com/..." }

T+3  Frontend receives authUrl, redirects browser:
       window.location.href = authUrl

T+4  Browser navigates to Slack's OAuth consent screen.
     User logs in (if needed) and clicks "Allow".

T+5  Slack redirects browser to:
       https://zappy.com/connections/oauth/callback
         ?code=abc123
         &state=eyJjb25u...Q.a1b2c3...f9

T+6  Browser follows redirect → GET /connections/oauth/callback?code=abc123&state=...
     (No JWT header — browser-initiated redirect)

T+7  oauthCallback handler:
     verifyOAuthState(state):
       Split at lastIndexOf('.') → payload + receivedHmac
       Recompute expectedHmac = HMAC-SHA256(payload, JWT_SECRET) = "a1b2c3...f9"
       timingSafeEqual(receivedHmac, expectedHmac) → true ✅
       Decode payload → { connectorId: "slack", userId: "42" }

T+8  exchangeCode("slack", "abc123"):
     POST https://slack.com/api/oauth.v2.access
       client_id, client_secret, code, redirect_uri, grant_type=authorization_code
     Slack responds:
       { ok: true, access_token: "xoxb-...", team: { id: "T01234" }, authed_user: { id: "U99" } }
     Normalize:
       accessToken = "xoxb-..."
       refreshToken = ""        (Slack doesn't issue refresh tokens for bots)
       externalAccountId = "T01234"  (Slack workspace ID)
       expiresAt = null              (bot tokens don't expire)

T+9  prisma.connection.upsert({
       where: { userId_connectorId_externalAccountId: {
         userId: 42n, connectorId: "slack", externalAccountId: "T01234"
       }},
       create: {
         userId: 42n, connectorId: "slack", label: "Slack • T01234",
         externalAccountId: "T01234",
         accessToken: encrypt("xoxb-..."),   // AES-256-GCM, stored as base64
         refreshToken: encrypt(""),
         expiresAt: null,
       },
       update: { ... same fields ... },   // If reconnecting same workspace
     })

T+10 res.redirect(env.WEB_APP_URL + '/connections?connected=slack')
     Browser navigates back to Zappy dashboard, showing "Slack connected ✓"

Total OAuth round-trip time: ~1-2 seconds
```

The user's Slack workspace is now connected. The encrypted access token lives in the DB.
When a zap runs, the worker calls `decrypt(connection.accessToken)` to get `"xoxb-..."` and
uses it in the `Authorization: Bearer xoxb-...` header for Slack API calls.

---

*Continue to: [DD9 — The Zap Controller: Every Endpoint, Line by Line](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD9_ZAP_CONTROLLER_FULL.md)*
