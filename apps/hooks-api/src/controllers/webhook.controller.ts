import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { ingestWebhook } from '../services/webhook-ingest.service';
import { logger } from '../lib/logger';

type RawRequest = Request & { rawBody: Buffer };

export async function handleWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const { zapId, stepId } = req.params;

  // Signature header — picked up in priority order:
  //   GitHub:   X-Hub-Signature-256  (value: "sha256=<hex>")
  //   Razorpay: X-Razorpay-Signature (value: plain hex)
  //   Generic:  X-Webhook-Signature  (value: plain hex)
  // hmac-verify.service strips the "sha256=" prefix automatically.
  const signature =
    (req.headers['x-hub-signature-256'] as string) ??
    (req.headers['x-razorpay-signature'] as string) ??
    (req.headers['x-webhook-signature'] as string) ??
    '';

  // Event ID — used for deduplication. Picked up in priority order:
  //   GitHub:   X-GitHub-Delivery (UUID)
  //   Razorpay: X-Razorpay-Event-Id
  //   Generic:  X-Webhook-Id
  //   Fallback: generated UUID
  const eventId =
    (req.headers['x-github-delivery'] as string) ??
    (req.headers['x-razorpay-event-id'] as string) ??
    (req.headers['x-webhook-id'] as string) ??
    `${zapId}-${randomUUID()}`;

  const rawBody = (req as RawRequest).rawBody ?? Buffer.alloc(0);

  // X-GitHub-Event is present only on GitHub deliveries.
  // It is passed to ingestWebhook for tier-1 event-type routing.
  const githubEventType = (req.headers['x-github-event'] as string) ?? '';

  try {
    const result = await ingestWebhook(zapId, stepId, rawBody, signature, eventId, githubEventType);

    switch (result.status) {
      case 'unauthorized':
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      case 'not_found':
        // Return 200 anyway — don't leak info about zap existence to attackers
        res.status(200).json({ received: true });
        return;
      case 'ingested':
      case 'duplicate':
      case 'skipped':
        // Always 200 — provider must not retry just because we already have it
        // or because the event type didn't match the step's trigger config
        res.status(200).json({ received: true });
        return;
    }
  } catch (err) {
    logger.error({ err, zapId, stepId }, '[hooks-api] Ingest error');
    // Return 500 so the provider retries — we don't want to lose real events
    res.status(500).json({ error: 'Ingest failed, please retry' });
  }
}
