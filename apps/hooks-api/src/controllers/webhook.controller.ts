import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ingestWebhook } from '../services/webhook-ingest.service';

type RawRequest = Request & { rawBody: Buffer };

export async function handleWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const { zapId, stepId } = req.params;

  // Signature from header — Razorpay sends X-Razorpay-Signature
  // Generic webhooks use X-Webhook-Signature
  const signature =
    (req.headers['x-razorpay-signature'] as string) ??
    (req.headers['x-webhook-signature'] as string) ??
    '';

  // Use provider-supplied event ID if available, otherwise generate one
  const eventId =
    (req.headers['x-razorpay-event-id'] as string) ??
    (req.headers['x-webhook-id'] as string) ??
    `${zapId}-${uuidv4()}`;

  const rawBody = (req as RawRequest).rawBody ?? Buffer.alloc(0);

  try {
    const result = await ingestWebhook(zapId, stepId, rawBody, signature, eventId);

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
        // Always 200 — provider must not retry just because we already have it
        res.status(200).json({ received: true });
        return;
    }
  } catch (err) {
    console.error('[hooks-api] Ingest error:', err);
    // Return 500 so the provider retries — we don't want to lose real events
    res.status(500).json({ error: 'Ingest failed, please retry' });
  }
}
