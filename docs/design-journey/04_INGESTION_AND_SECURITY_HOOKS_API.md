# Chapter 4 — Ingestion Engine & Cryptographic Security (`hooks-api`)

> **ZapFlow Builder's Manual & Architecture Journey**  
> *Chapter 4 of 10*

---

## 4.1 Ingestion Gateway Architecture & Philosophy

The `hooks-api` service (`apps/hooks-api`) is the most exposed, high-traffic service in the entire ZapFlow cluster. It runs on **Port 3002** and is deliberately isolated from the rest of the application codebase.

```
Incoming Webhook (Public Internet)
                │
                ▼
      ┌──────────────────┐
      │   Rate Limiter   │  300 req/min per IP
      └─────────┬────────┘
                ▼
      ┌──────────────────┐
      │ Raw Body Stream  │  Buffers chunks into raw Uint8Array Buffer (Max 5MB)
      └─────────┬────────┘
                ▼
      ┌──────────────────┐
      │   HMAC Verify    │  crypto.timingSafeEqual (constant-time check)
      └─────────┬────────┘
                ▼
      ┌──────────────────┐
      │   Event Filter   │  GitHub Event / Action header matching
      └─────────┬────────┘
                ▼
      ┌─────────────────────────────────────────────────────────────┐
      │               Atomic PostgreSQL Transaction                 │
      │  1. INSERT webhook_events ON CONFLICT DO NOTHING            │
      │  2. INSERT zap_runs (status = 'queued')                     │
      │  3. INSERT outbox (status = 'pending')                      │
      └─────────────────────────┬───────────────────────────────────┘
                                ▼
                       Return HTTP 200 OK
```

### Critical Architectural Constraints:
1. **Zero External API Calls:** `hooks-api` never calls Slack, GitHub, or any remote service. Its sole job is to ingest, verify, record, and acknowledge.
2. **Zero In-Memory Queues:** It does not produce to Kafka directly, shielding the ingest gateway from message broker network latency or cluster partition rebalances.
3. **Sub-30ms Response Latency:** Upstream webhook dispatchers (Stripe, GitHub, Razorpay) are acknowledged almost instantaneously.

---

## 4.2 Raw Body Buffering vs. JSON Parsing

In typical Express applications, `express.json()` is registered globally. **In `hooks-api`, doing this is a catastrophic security bug.**

### Why JSON Parsing Breaks Cryptographic Signatures:
When a webhook sender (e.g., GitHub) generates an HMAC-SHA256 signature, it hashes the **exact sequence of raw bytes transmitted over the TCP socket**:

$$\text{Signature} = \text{HMAC-SHA256}(K_{secret}, \text{Bytes}_{wire})$$

If Express parses the request body into a JavaScript object via `express.json()`, and the application later converts it back using `JSON.stringify(req.body)`, the raw byte sequence is permanently altered:
- Key order changes (JavaScript objects have non-deterministic serialization orders).
- Whitespace formatting is erased (`{"amount": 100}` vs `{"amount":100}`).
- Floating point formatting changes (`100.0` becomes `100`).
- Unicode escapes are normalized (`\u0026` becomes `&`).

As a result, $\text{HMAC}(\text{JSON.stringify}(req.body)) \neq \text{Signature}_{received}$, causing every valid webhook to be rejected with HTTP 401!

### The Solution: `apps/hooks-api/src/middleware/raw-body.middleware.ts`

```typescript
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB

export function rawBodyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  req.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Payload too large (max 5MB)' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    (req as Request & { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });

  req.on('error', next);
}
```

#### Why This Implementation is Robust:
1. **Memory Exhaustion Guard:** Tracks `totalBytes` on every streamed chunk. If an attacker attempts a Denial of Service attack by streaming a 1GB payload, the connection is instantly aborted (`req.destroy()`) and HTTP 413 is returned before server RAM is exhausted.
2. **Preservation of Raw Bytes:** Concatenates incoming buffers into `req.rawBody` without converting to string or decoding characters.

---

## 4.3 Cryptographic Verification & Timing Attack Prevention

The verification engine lives in `apps/hooks-api/src/services/hmac-verify.service.ts`:

```typescript
import crypto from 'crypto';

export function verifyWebhook(
  rawBody: Buffer,
  receivedSignature: string,
  secret: string,
): boolean {
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Strip "sha256=" prefix if present (GitHub format)
  const normalizedSignature = receivedSignature.startsWith('sha256=')
    ? receivedSignature.slice(7)
    : receivedSignature;

  const computedBuf = Buffer.from(computed, 'hex');
  const receivedBuf = Buffer.from(normalizedSignature, 'hex');

  // Length guard before timingSafeEqual (required — throws if lengths differ)
  if (computedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(computedBuf, receivedBuf);
}
```

### The Mathematics of Timing Attacks: Why `===` is Vulnerable

Consider standard string equality (`computed === received`):
```
Computed: 8 a 4 f c 2 ...
Received: 8 a 9 1 0 0 ...
             ^ mismatch detected at character 3! Comparison halts immediately.
```
In standard string comparison, the CPU breaks early on the first mismatched byte. An attacker measuring the round-trip latency with high-resolution timers can determine how many leading bytes matched:
- If character 0 is wrong: Returns in 1.002ms.
- If character 0 is correct: Returns in 1.008ms.

By iterating through all hexadecimal characters ($0-9, a-f$), the attacker can deduce the valid signature byte by byte without ever knowing the underlying secret key!

### The Constant-Time Guarantee:
`crypto.timingSafeEqual(bufA, bufB)` compares every single byte in the buffer using bitwise XOR operations, regardless of where the first mismatch occurs. The execution time is identical whether zero bytes match or all 32 bytes match:

$$\text{Time}(\text{timingSafeEqual}) = \mathcal{O}(L) \quad \text{strictly constant for buffer length } L$$

#### The Length Guard Gotcha:
`crypto.timingSafeEqual` throws an unhandled `RangeError` if `bufA.length !== bufB.length`.  
The line:
```typescript
if (computedBuf.length !== receivedBuf.length) return false;
```
prevents the application from crashing when malformed or truncated signature headers are sent.

---

## 4.4 Webhook Ingestion Controller (`webhook.controller.ts`)

Let us inspect `apps/hooks-api/src/controllers/webhook.controller.ts`:

```typescript
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const { zapId, stepId } = req.params;

  // Guard 1: Reject non-numeric IDs before BigInt() parsing
  if (!/^\d+$/.test(zapId) || !/^\d+$/.test(stepId)) {
    res.status(200).json({ received: true });
    return;
  }

  // Guard 2: Multi-vendor signature header extraction
  const signature =
    (req.headers['x-hub-signature-256'] as string) ??
    (req.headers['x-razorpay-signature'] as string) ??
    (req.headers['x-webhook-signature'] as string) ??
    '';

  // Guard 3: Deduplication Event ID extraction with fallback
  const eventId =
    (req.headers['x-github-delivery'] as string) ??
    (req.headers['x-razorpay-event-id'] as string) ??
    (req.headers['x-webhook-id'] as string) ??
    `${zapId}-${randomUUID()}`;

  const rawBody = (req as RawRequest).rawBody ?? Buffer.alloc(0);
  const githubEventType = (req.headers['x-github-event'] as string) ?? '';

  try {
    const result = await ingestWebhook(zapId, stepId, rawBody, signature, eventId, githubEventType);

    switch (result.status) {
      case 'unauthorized':
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      case 'not_found':
        // Silently return 200 — do not leak Zap existence to attackers!
        res.status(200).json({ received: true });
        return;
      case 'ingested':
      case 'duplicate':
      case 'skipped':
        // Return 200 — provider must not retry
        res.status(200).json({ received: true });
        return;
    }
  } catch (err) {
    logger.error({ err, zapId, stepId }, '[hooks-api] Ingest error');
    // Return 500 so upstream provider retries genuine server errors
    res.status(500).json({ error: 'Ingest failed, please retry' });
  }
}
```

### Critical Defensive Design Decisions:

1. **Non-Numeric ID Guard:**  
   If an automated scanner probes `/hooks/test/random`, `BigInt("test")` throws an uncaught JavaScript syntax error. The regex `/^\d+$/` catches this at the gateway and safely drops the request.
2. **Preventing Information Leakage (`not_found` returns HTTP 200):**  
   If an attacker port-scans `/hooks/1/0`, `/hooks/2/0`, etc., returning `HTTP 404` tells them exactly which Zap IDs exist on the server. Returning `HTTP 200 {"received": true}` renders user endpoints completely indistinguishable from non-existent endpoints.
3. **Provider Retries vs. Acknowledgments:**  
   - If an event is a **duplicate**, return `HTTP 200`. If we returned `HTTP 409 Conflict`, the provider would interpret it as a failure and retry again.
   - If a real database crash occurs in the `catch` block, return `HTTP 500`. This signals the upstream provider (GitHub/Razorpay) that our server failed, prompting their automated retry policy to redeliver the event later!

---

## 4.5 GitHub Trigger Routing Table (`webhook-ingest.service.ts`)

GitHub sends all webhooks for a repository to a single configured webhook URL, regardless of whether the event is an issue, a pull request, or a git push. To support fine-grained triggers (`github:issue_opened`, `github:pull_request_opened`, etc.), `hooks-api` implements an in-memory routing table:

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

### Selective Ingestion Logic:
When a delivery arrives:
1. `hooks-api` inspects the `X-GitHub-Event` header.
2. If the user's trigger is `github:issue_opened`, but GitHub delivered `X-GitHub-Event: issues` with payload `action: "closed"`, the helper `matchesGitHubTrigger` returns `false`.
3. The ingest status returns `'skipped'`, and `hooks-api` returns `HTTP 200 OK`. The event is discarded immediately before touching the outbox or Kafka, eliminating compute waste while preventing GitHub from retrying.

---

## 4.6 The Atomic Ingestion Transaction

When an event passes validation, it must be persisted:

```typescript
const result = await prisma.$transaction(async (tx) => {
  // 1. Insert webhook event (idempotency barrier)
  const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO webhook_events (event_id, zap_id, payload)
    VALUES (${eventId}, ${BigInt(zapId)}, ${payload}::jsonb)
    ON CONFLICT (event_id, zap_id) DO NOTHING
    RETURNING id
  `;

  if (rows.length === 0) {
    logger.info({ zapId, stepId, eventId }, 'duplicate webhook event — skipping outbox write');
    return 'duplicate';
  }

  const webhookEventId = rows[0].id;

  // 2. Immediately create zap_run in 'queued' state for frontend UI feedback
  await tx.$executeRaw`
    INSERT INTO zap_runs (zap_id, webhook_event_id, status)
    VALUES (${BigInt(zapId)}, ${webhookEventId}, 'queued')
    ON CONFLICT (webhook_event_id) DO NOTHING
  `;

  // 3. Insert outbox record for the background relay
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

### Why This Transaction is Fault-Tolerant:
If the server crashes or loses database connectivity anywhere during these three operations, PostgreSQL rolls back the entire transaction. There is **zero possibility** of an orphan `webhook_event` without an `outbox` row, or an `outbox` row pointing to a missing `zap_run`.

In Chapter 5, we explore how the `relay` daemon monitors this outbox table and guarantees delivery to Apache Kafka.
