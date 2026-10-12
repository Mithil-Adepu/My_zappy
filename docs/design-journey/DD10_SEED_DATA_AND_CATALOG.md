# Deep Dive 10 — Seed Data & Connector Catalog: Every Entry Explained

> This is the final Deep Dive. It covers `seed.js` — the script that bootstraps the connector
> catalog — explaining every connector, every trigger, every action, and every JSON Schema entry.
> It explains why seeds use upsert (not insert), why seed.js is plain JS (not TypeScript), how
> `payloadSchema` drives the template-mapping UI, how `inputSchema` drives the AJV validation
> in the worker, why `supportsIdempotencyKey` is a connector-level flag, and what the
> "Webhooks by ZapFlow" generic connector is and why it exists.

---

## Table of Contents

1. [What Seeding Is and When It Runs](#1-what-seeding-is-and-when-it-runs)
2. [Why `seed.js` Is Plain JavaScript (Not TypeScript)](#2-why-seedjs-is-plain-javascript-not-typescript)
3. [The Upsert Pattern — Idempotent Seeds](#3-the-upsert-pattern--idempotent-seeds)
4. [The Connector Catalog — Four Connectors](#4-the-connector-catalog--four-connectors)
5. [Slack Connector — OAuth Flow, Trigger-less](#5-slack-connector--oauth-flow-trigger-less)
6. [Razorpay Connector — `api_key`, `supportsIdempotencyKey: true`](#6-razorpay-connector--api_key-supportsidempotencykey-true)
7. [GitHub Connector — `api_key`, Multiple Triggers, One Action](#7-github-connector--api_key-multiple-triggers-one-action)
8. [Webhooks by ZapFlow — The Generic Catch-All](#8-webhooks-by-zapflow--the-generic-catch-all)
9. [JSON Schema in `payloadSchema` — How It Drives the UI](#9-json-schema-in-payloadschema--how-it-drives-the-ui)
10. [JSON Schema in `inputSchema` — How It Drives Validation and Forms](#10-json-schema-in-inputschema--how-it-drives-validation-and-forms)
11. [The ID Convention — `connector:action-name`](#11-the-id-convention--connectoraction-name)
12. [The Complete Catalog Reference](#12-the-complete-catalog-reference)

---

## 1. What Seeding Is and When It Runs

**Seeding** is the act of populating a database with initial reference data required before the
application can function. Unlike migrations (which define the schema), seeds populate data.

In Zappy, the seed data is the **connector catalog**: the list of available integrations (Slack,
GitHub, Razorpay), their triggers (events that can fire a zap), and their actions (things a zap
can do). Without seed data:
- The frontend's connector picker shows nothing
- Users cannot create any zaps (no triggers or actions to select)
- The worker's adapter registry would be pointless (no DB entries to match against)

**When seeding runs:**

1. **During development:** `pnpm db:seed` (which Turborepo makes depend on `db:migrate`).
2. **In Docker:** `app-api`'s startup command is `prisma migrate deploy && node dist/server.js`.
   The seed is NOT run automatically in Docker — it must be run once after initial deployment:
   ```bash
   docker exec -it zapier_app_api node node_modules/@zapier-clone/db/seed.js
   ```
   This is intentional — re-running seed data on every startup would be wasteful (upserts are
   idempotent, but still execute DB queries).

3. **In tests (E2E):** The E2E test setup runs seed before the test suite starts, ensuring the
   catalog exists.

**What is NOT in the seed:** Users, zaps, connections, runs — these are user-generated data,
not reference data. Seeds only populate data that defines the product's capabilities.

---

## 2. Why `seed.js` Is Plain JavaScript (Not TypeScript)

```javascript
// Plain JS seed — run inside the production Docker container with:
//   node node_modules/@zapier-clone/db/seed.js
//
// No TypeScript, no ts-node needed — only @prisma/client (which is a prod dep).

'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
```

**The problem with TypeScript seeds in production:**

If `seed.ts` were TypeScript, you'd need either:
1. `ts-node seed.ts` — requires `ts-node` and TypeScript as dependencies in production
2. Compile it first: `tsc seed.ts && node seed.js` — adds a build step

`ts-node` is a development tool — it should not be in production images. Compiling requires
a TypeScript compiler in the Docker image.

**The plain JS solution:** `seed.js` is pre-compiled JavaScript. It requires only:
- Node.js (already in the Docker image)
- `@prisma/client` (a production dependency)

No TypeScript, no `ts-node`, no build step. Run with `node seed.js` directly.

**`'use strict'`** — enables strict mode in Node.js for this file. In strict mode:
- Variables must be declared (prevents accidental globals)
- `this` is `undefined` in functions (not the global object)
- Duplicate property names in objects throw a SyntaxError

For a script that runs once and must be reliable, strict mode is appropriate.

**`const prisma = new PrismaClient()`** — note: NOT the shared singleton pattern from
`packages/db/src/index.ts`. The seed script creates its own `PrismaClient` directly.
This is fine because the seed runs as a one-shot script (not a long-running server). The
`finally` block calls `prisma.$disconnect()` to release the connection pool when done.

---

## 3. The Upsert Pattern — Idempotent Seeds

Every seed entry uses `upsert`:

```javascript
await prisma.connector.upsert({
  where: { id: 'slack' },
  update: {},    // ← empty object — no-op update
  create: {
    id: 'slack',
    name: 'Slack',
    ...
  },
});
```

**Why `upsert` and not `create`?**

If seed runs twice (e.g., developer re-runs `pnpm db:seed` after a failed run):
- `create` would throw: `Unique constraint failed on the fields: (id)`
- `upsert` with `update: {}` finds the existing row and does nothing

**`update: {}` — the no-op update trick:**

In a real upsert, `update` contains fields to set when the row exists. We don't want to modify
existing connector entries (an admin might have changed `imageUrl` or `scopes`). By providing
an empty `update: {}`, Prisma generates:
```sql
INSERT INTO connectors (...) VALUES (...)
ON CONFLICT (id) DO UPDATE SET   -- nothing — empty UPDATE means no-op
```

Wait — does `DO UPDATE SET` with nothing actually work in SQL? Prisma handles this: when
`update: {}` is provided, Prisma generates the Postgres `ON CONFLICT ... DO UPDATE SET id = id`
pattern (a self-assignment that's a no-op) or uses `ON CONFLICT DO NOTHING` depending on the
Prisma version.

**The practical result:** Running the seed 100 times produces the same DB state as running it once.
This property — where re-running produces the same result — is called **idempotency**. Critical
for scripts that might be run by CI pipelines, developers, or during automated deployment.

---

## 4. The Connector Catalog — Four Connectors

The seeded catalog contains four connectors:

| ID | Name | Auth Type | Triggers | Actions | idempotencyKey |
|----|------|-----------|----------|---------|----------------|
| `slack` | Slack | `oauth` | 0 | 1 | false |
| `razorpay` | Razorpay | `api_key` | 1 | 1 | **true** |
| `github` | GitHub | `api_key` | 3 | 1 | false |
| `webhooks` | Webhooks by ZapFlow | `api_key` | 1 | 0 | false |

**Note: Slack has NO triggers.** This is intentional — Slack's webhook model is different from
most providers. Slack doesn't push events to Zappy; Zappy would need to connect as a Slack app
and receive events via the Events API (different from webhook push). For the MVP, Slack is an
action-only connector (you can send messages but not trigger on Slack events).

---

## 5. Slack Connector — OAuth Flow, Trigger-less

```javascript
await prisma.connector.upsert({
  where: { id: 'slack' },
  create: {
    id: 'slack',
    name: 'Slack',
    imageUrl: 'https://cdn.worldvectorlogo.com/logos/slack-new-logo.svg',
    authType: 'oauth',
    authUrl:  'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes:   ['chat:write', 'channels:read'],
    supportsIdempotencyKey: false,
  },
});
```

### `authType: 'oauth'` — what this unlocks

When `authType === 'oauth'`, the frontend shows an "Authorize with Slack" button (not an API
key input field). The connection flow goes through `startOAuth` → Slack OAuth consent screen →
`oauthCallback` → token stored encrypted.

`authUrl` and `tokenUrl` duplicate what's hardcoded in `oauth.service.ts`'s `getOAuthConfig`.
The DB values are used by the frontend (to generate informational text like "Redirecting to
Slack...") while the service code uses the hardcoded values for the actual OAuth requests.
Technically they should be the same, but they're stored in two places.

### `scopes: ['chat:write', 'channels:read']`

**`chat:write`** — bot can post messages to channels it's been invited to.
**`channels:read`** — bot can list public channels. Used to populate a channel picker in the
configuration UI.

**Why minimal scopes?** The principle of least privilege. Requesting only the scopes needed means:
1. Users are less likely to be alarmed during consent ("why does this need to read my DMs?")
2. If credentials are compromised, the attacker has limited capabilities

### `supportsIdempotencyKey: false`

Slack's API does not support idempotency keys on `chat.postMessage`. Sending the same message
twice results in two identical messages being posted. There's no way to tell Slack "only post
this message once."

This means the worker's step-runner does NOT send an `X-Idempotency-Key` header for Slack
actions, and if a Slack step is ambiguous (lease expired), the worker marks it `ambiguous` and
DOES NOT retry (to avoid duplicate messages). See DD3 §13 for the full ambiguous status logic.

### The `send-message` action

```javascript
await prisma.availableAction.upsert({
  where: { id: 'slack:send-message' },
  create: {
    id:          'slack:send-message',
    connectorId: 'slack',
    name:        'Send Message',
    inputSchema: {
      type: 'object',
      required: ['channel', 'text'],
      properties: {
        channel: { type: 'string', title: 'Channel', description: '...' },
        text:    { type: 'string', title: 'Message Text', description: '...' },
      },
    },
  },
});
```

**`required: ['channel', 'text']`** — AJV in the worker validates that the resolved `config`
contains both fields before calling the Slack API. If `channel` is missing (e.g., the template
`{{step_0.channel}}` resolved to `undefined`), AJV rejects with "channel is required" and the
step fails with `VALIDATION_ERROR`.

**`title` and `description` fields** — not validated by AJV. These are display metadata for the
frontend's form renderer. The field mapping UI shows "Channel" (title) and "Slack channel ID
or name (e.g. #general)" (description) next to the input.

---

## 6. Razorpay Connector — `api_key`, `supportsIdempotencyKey: true`

```javascript
await prisma.connector.upsert({
  where: { id: 'razorpay' },
  create: {
    id: 'razorpay', name: 'Razorpay',
    authType: 'api_key',
    authUrl: null, tokenUrl: null,  // No OAuth URLs — api_key connector
    scopes: [],
    supportsIdempotencyKey: true,   // ← Razorpay supports idempotency keys
  },
});
```

### `authType: 'api_key'` with `authUrl: null, tokenUrl: null`

The DB's `oauth_fields_required` CHECK constraint allows null `authUrl`/`tokenUrl` ONLY when
`authType = 'api_key'`:
```sql
CHECK (auth_type = 'api_key' OR (auth_url IS NOT NULL AND token_url IS NOT NULL))
```

For API key connectors, there's no OAuth flow. The user enters their API key and secret in a
form. `connectApiKey` stores them encrypted.

**`scopes: []`** — empty array. No OAuth scopes for API key connectors (OAuth scopes are an
OAuth concept, not an API key concept).

### `supportsIdempotencyKey: true`

Razorpay's API accepts an `X-Razorpay-Idempotency-Key` header. If you send a payment request
with the same idempotency key twice, Razorpay deduplicates it — only the first request creates
the payment, the second returns the first request's response.

The worker's step-runner:
1. If the connector supports idempotency: send `X-Idempotency-Key: <zap_run_step.idempotency_key>` (the UUID from the DB)
2. If not: don't send the header

This allows the worker to SAFELY retry Razorpay actions after ambiguous step failures:
- Step claimed → Razorpay API called → network drops before response
- Step marked `ambiguous`
- Recovery job reclaims step → re-calls Razorpay with SAME `idempotency_key`
- Razorpay deduplicates → returns first response (payment was created once)
- Step marked `completed`

Without idempotency key support, this recovery would create two payments!

### `payment-captured` trigger

```javascript
await prisma.availableTrigger.upsert({
  where: { id: 'razorpay:payment-captured' },
  create: {
    id:          'razorpay:payment-captured',
    connectorId: 'razorpay',
    name:        'Payment Captured',
    payloadSchema: {
      type: 'object',
      properties: {
        'payload.payment.entity.id':       { type: 'string', title: 'Payment ID' },
        'payload.payment.entity.amount':   { type: 'number', title: 'Amount (paise)' },
        'payload.payment.entity.currency': { type: 'string', title: 'Currency' },
        'payload.payment.entity.email':    { type: 'string', title: 'Customer Email' },
        'payload.payment.entity.contact':  { type: 'string', title: 'Customer Phone' },
      },
    },
  },
});
```

**The dot-notation property names:** Razorpay's webhook payload is deeply nested:
```json
{
  "event": "payment.captured",
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_AbC123",
        "amount": 50000,
        "currency": "INR",
        "email": "customer@example.com"
      }
    }
  }
}
```

To reference `payload.payment.entity.amount` in a template, users would write:
`{{step_0.payload.payment.entity.amount}}`.

The `payloadSchema` property names use dots as-is: `"payload.payment.entity.amount"`. This
signals to the frontend that this is a nested path reference, not a top-level key. The `resolvePath`
function in the worker supports dot-notation paths (DD3 §11).

**`type: 'number'` for `amount`** — Razorpay amounts are integers (paise). By declaring
`type: 'number'`, the frontend's template mapper shows this as a numeric field.
Type-preserving substitution (DD3 §8) ensures that `{{step_0.amount}}` substitutes to the
number `50000` (not the string `"50000"`) when building the action config.

---

## 7. GitHub Connector — `api_key`, Multiple Triggers, One Action

GitHub uses Personal Access Tokens (PAT) for authentication — an API key connector.
It has the richest trigger catalog: three triggers for the most common GitHub events.

### `github:push` — Push to Branch

```javascript
payloadSchema: { type: 'object',
  description: 'Fires when commits are pushed to any branch or tag.',
  properties: {
    ref:                    { type: 'string', title: 'Ref',            description: 'Full ref, e.g. refs/heads/main' },
    before:                 { type: 'string', title: 'Before SHA' },
    after:                  { type: 'string', title: 'After SHA' },
    'repository.full_name': { type: 'string', title: 'Repository' },
    'repository.html_url':  { type: 'string', title: 'Repository URL' },
    'pusher.name':          { type: 'string', title: 'Pusher Name' },
    'pusher.email':         { type: 'string', title: 'Pusher Email' },
    compare:                { type: 'string', title: 'Compare URL' },
  }
}
```

**GitHub's push webhook payload** is large (40+ fields). The `payloadSchema` here lists only
the most useful fields — the ones a user would reasonably want to reference in templates. An
`inputSchema` / `payloadSchema` is not an exhaustive list of all fields — it's a curated set
of user-facing fields. The worker's `resolvePath` can access ANY path in the payload regardless
of whether it's listed in the schema.

**`'repository.full_name'`** — GitHub sends `repository: { full_name: "facebook/react" }`.
Using dot-notation in the schema key means the user writes `{{step_0.repository.full_name}}` in
their template, and `resolvePath` navigates the nested object correctly.

**The `description` on the schema object itself** (`description: 'Fires when commits...'`) —
not a JSON Schema standard field on individual properties but valid at the object level. The
frontend displays this as a tooltip on the trigger card.

### `github:pull_request_opened` and `github:issue_opened`

Similar patterns. Key fields:
- `pull_request.number`, `pull_request.title`, `pull_request.html_url` — PR identification
- `pull_request.user.login` — who opened the PR (uses double-dot notation for triple-nesting)
- `pull_request.head.ref`, `pull_request.base.ref` — source and target branches

### `github:create-issue` action

```javascript
inputSchema: {
  type: 'object',
  required: ['owner', 'repo', 'title'],
  properties: {
    owner: { type: 'string', title: 'Repository Owner', description: 'e.g. facebook' },
    repo:  { type: 'string', title: 'Repository Name',  description: 'e.g. react' },
    title: { type: 'string', title: 'Issue Title' },
    body:  { type: 'string', title: 'Issue Body', description: 'Markdown body...' },
  },
}
```

**`required: ['owner', 'repo', 'title']`** — AJV in the worker validates these are present
after template substitution. `body` is optional — an issue without a body is valid on GitHub.

**`owner` and `repo` as separate fields** — rather than a combined `owner/repo` string (like
`facebook/react`). Why separate? The user might want to template `owner` from the trigger
payload (`{{step_0.repository.full_name.split('/')[0]}}`) — except template substitution doesn't
support function calls. Keeping them separate allows mapping each independently:
```json
{ "owner": "{{step_0.pusher.name}}", "repo": "my-monorepo", "title": "Deploy failed" }
```

This is a common pattern: flatten composite values into separate fields when each might be
independently templated.

---

## 8. Webhooks by ZapFlow — The Generic Catch-All

```javascript
await prisma.connector.upsert({
  where: { id: 'webhooks' },
  create: {
    id: 'webhooks', name: 'Webhooks by ZapFlow',
    authType: 'api_key',
    supportsIdempotencyKey: false,
  },
});

await prisma.availableTrigger.upsert({
  where: { id: 'webhooks:catch_hook' },
  create: {
    id:          'webhooks:catch_hook',
    connectorId: 'webhooks',
    name:        'Catch Hook (Any Webhook)',
    payloadSchema: {
      type: 'object',
      description: 'Accepts any webhook payload. Use dot-notation paths (e.g. {{data.user.email}}) to reference fields.',
      properties: {},
      additionalProperties: true,
    },
  },
});
```

### What this connector IS

"Webhooks by ZapFlow" is a **generic webhook trigger** — inspired by Zapier's own "Webhooks by
Zapier" connector. It allows users to trigger a zap from ANY HTTP webhook, not just from
supported connectors like GitHub or Razorpay.

Use cases:
- Your homegrown backend sends webhooks with custom payloads
- A service not in the catalog (Stripe, Shopify, PagerDuty) sends webhooks
- A legacy system that uses webhooks but isn't in the catalog

### `additionalProperties: true` — the open schema

```json
{
  "type": "object",
  "properties": {},              // ← Empty: no specific fields defined
  "additionalProperties": true   // ← Any field is allowed
}
```

`payloadSchema.properties: {}` is empty — we don't know in advance what fields the incoming
webhook has. `additionalProperties: true` tells JSON Schema validators (and the frontend's UI)
that any payload shape is valid.

**In the frontend:** The template mapper for this trigger can't show specific field suggestions
(because the schema is open). Instead, it shows the raw payload of the last received webhook
event, allowing users to discover and reference fields manually.

**In the worker:** `payloadSchema` is used only by the frontend mapper, not by AJV validation.
The worker validates action `config` against action `inputSchema` — trigger `payloadSchema` is
informational only.

### `authType: 'api_key'` — but no real API key

The "Webhooks by ZapFlow" connector uses `authType: 'api_key'` technically, but in practice
the "API key" is the `webhookSecret` on the trigger step — the HMAC key used to verify incoming
webhook signatures. The frontend's "Connect Webhooks by ZapFlow" flow would ask for no credentials
(or just the webhook secret which is auto-generated).

This is a slight misuse of the `authType` field. A more accurate authType would be `webhook_secret`
but that's not in the supported enum. The current design works because the actual HMAC verification
uses `step.webhookSecret` from the `zap_steps` table, not any connection's `apiKey`.

---

## 9. JSON Schema in `payloadSchema` — How It Drives the UI

`payloadSchema` is stored in `available_triggers.payload_schema` as JSONB.

**Frontend use:** The template field mapping UI (the "configure your action" step when building
a zap) reads `payloadSchema` from `GET /connectors/:id/triggers`. It uses the schema to:

1. **Show available fields:** "You can reference: Payment ID, Amount (paise), Currency..."
2. **Type hints:** Numeric fields show number inputs; string fields show text inputs
3. **Descriptions:** `description` fields appear as tooltips on hover
4. **Validation:** The UI warns if you try to map a field that doesn't exist in the schema

**What `payloadSchema` does NOT do:**
- It does NOT validate incoming webhook payloads (the worker doesn't AJV-validate webhooks)
- It does NOT restrict which payload fields can be referenced in templates (`resolvePath` works
  on any path, whether or not it's in the schema)

Think of `payloadSchema` as a **documentation contract** between the trigger's behavior and the
frontend's UI. It's descriptive, not prescriptive.

### The `title` field convention

Every property has a `title`:
```json
{ "type": "string", "title": "Payment ID" }
```

`title` is a standard JSON Schema meta-keyword. The frontend displays `title` as the
human-readable label for the field. Without `title`, the frontend would display the raw
property key (`payload.payment.entity.id`) — not user-friendly.

---

## 10. JSON Schema in `inputSchema` — How It Drives Validation and Forms

`inputSchema` is stored in `available_actions.input_schema` as JSONB.

**Two consumers:**

1. **Worker (AJV validation, DD3 §9):** Validates the resolved `config` before the HTTP call:
   ```typescript
   const validator = ajv.compile(step.availableAction.inputSchema);
   const valid = validator(resolvedConfig);
   if (!valid) throw createError('VALIDATION_ERROR', validator.errors);
   ```

2. **Frontend (form rendering):** Reads `inputSchema` from `GET /connectors/:id/actions` to
   render the configuration form. For Slack's `send-message`:
   ```
   ┌─────────────────────────────────┐
   │ Channel (required)              │
   │ Slack channel ID or name...     │
   │ ┌───────────────────────────┐   │
   │ │ #general or {{step_0...}} │   │
   │ └───────────────────────────┘   │
   │                                 │
   │ Message Text (required)         │
   │ Message body...                 │
   │ ┌───────────────────────────┐   │
   │ │ Payment received: {{...}} │   │
   │ └───────────────────────────┘   │
   └─────────────────────────────────┘
   ```

**The `required` array is critical for both consumers:**
- Frontend shows asterisks on required fields
- Worker's AJV fails validation if required fields are empty after template substitution

### Relaxed AJV validation (revisited from DD3 §9)

The worker uses AJV with `coerceTypes: true` and `useDefaults: true`. This means:
- `"50000"` (string) is coerced to `50000` (number) if the schema says `type: number`
- Missing optional fields get their `default` value if specified in the schema

This is important for templates: template substitution produces strings (everything from a
webhook payload path is a string). Coercion handles the type mismatch for numeric fields.

---

## 11. The ID Convention — `connector:action-name`

All trigger and action IDs follow the format `connectorId:action-name`:
- `slack:send-message`
- `razorpay:payment-captured`
- `razorpay:create-payment`
- `github:push`
- `github:pull_request_opened`
- `github:create-issue`
- `webhooks:catch_hook`

**Why this convention?**

1. **Globally unique without a UUID:** `slack:send-message` is globally unique because connector
   IDs are globally unique. No two connectors would share the same ID.

2. **Human-readable in logs:** When a step fails, the error log includes `actionId:
   slack:send-message`. Immediately obvious what connector and action is involved.

3. **Self-describing:** The ID encodes both the connector AND the action. You can derive the
   `connectorId` from the action ID by splitting at `:`.

4. **Adapter registration:** The worker's adapter registry uses this exact ID format:
   ```typescript
   registerAdapter({
     actionId: 'slack:send-message',
     execute: async (config, connection) => { ... },
   });
   ```
   The adapter's `actionId` matches the DB's `available_actions.id`. This is the lookup key.

5. **Stable and versionless:** Unlike numeric IDs (which are arbitrary), string IDs communicate
   semantic meaning. If you see `id: 7` in the DB, you need to look it up. If you see
   `id: 'github:create-issue'`, you know exactly what it is.

---

## 12. The Complete Catalog Reference

### Connectors

| ID | Auth Type | Triggers | Actions | Idempotency |
|----|-----------|----------|---------|-------------|
| `slack` | oauth | 0 | 1 | ❌ |
| `razorpay` | api_key | 1 | 1 | ✅ |
| `github` | api_key | 3 | 1 | ❌ |
| `webhooks` | api_key | 1 | 0 | ❌ |

### Triggers

| ID | Title | Connector | Key Fields |
|----|-------|-----------|------------|
| `razorpay:payment-captured` | Payment Captured | Razorpay | amount, email, contact, currency |
| `github:push` | Push to Branch | GitHub | ref, after, pusher.name, repository.full_name |
| `github:pull_request_opened` | Pull Request Opened | GitHub | PR number, title, author, branches |
| `github:issue_opened` | Issue Opened | GitHub | issue number, title, author, repository |
| `webhooks:catch_hook` | Catch Hook (Any Webhook) | Webhooks | Any (open schema) |

### Actions

| ID | Title | Connector | Required Fields | Optional |
|----|-------|-----------|-----------------|----------|
| `slack:send-message` | Send Message | Slack | channel, text | — |
| `razorpay:create-payment` | Create Payment Link | Razorpay | amount, currency | description |
| `github:create-issue` | Create Issue | GitHub | owner, repo, title | body |

---

## Epilogue: The System As a Whole

We have now documented every file in the Zappy codebase. From the raw HTTP byte arriving at
`hooks-api`, through HMAC verification, DB persistence, outbox polling, Kafka production,
worker consumption, sequential execution, rate limiting, credential decryption, HTTP dispatch,
OAuth token refresh, result storage — all the way to the runs API returning execution history
to the browser.

The 10 Deep Dive documents together form an exhaustive builder's manual:

| Chapter | Focus | Size |
|---------|-------|------|
| [DD1](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD1_HOOKS_API_LINE_BY_LINE.md) | Webhook ingestor | ~37KB |
| [DD2](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD2_RELAY_LINE_BY_LINE.md) | Outbox relay | ~24KB |
| [DD3](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD3_WORKER_ENGINE_LINE_BY_LINE.md) | Execution engine | ~64KB |
| [DD4](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD4_JOBS_AND_CONNECTORS.md) | Cron jobs & adapters | ~43KB |
| [DD5](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD5_APP_API_AUTH_AND_MIDDLEWARE.md) | Auth & middleware | ~57KB |
| [DD6](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD6_DATABASE_SCHEMA_AND_MIGRATIONS.md) | DB schema | ~37KB |
| [DD7](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD7_INFRASTRUCTURE_AND_DOCKER.md) | Docker & infra | ~42KB |
| [DD8](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD8_OAUTH_SERVICE_AND_ROUTES.md) | OAuth flow | ~36KB |
| [DD9](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD9_ZAP_CONTROLLER_FULL.md) | Zap CRUD | ~30KB |
| [DD10](file:///c:/webdevcode/PROJECTS/My_zappy/docs/design-journey/DD10_SEED_DATA_AND_CATALOG.md) | Seed & catalog | ~30KB |

**~400KB of documentation for the codebase that defines the system.**
