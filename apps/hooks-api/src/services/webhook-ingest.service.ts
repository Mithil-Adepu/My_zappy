import { prisma } from '@zapier-clone/db';
import { Prisma } from '@prisma/client';
import { verifyWebhook } from './hmac-verify.service';
import { logger } from '../lib/logger';

interface IngestResult {
  status: 'ingested' | 'duplicate' | 'unauthorized' | 'not_found';
}

/**
 * Core ingest logic — called by the webhook controller.
 *
 * Flow (from design doc §6):
 *  1. Look up the zap + trigger step to get the webhook_secret
 *  2. Verify HMAC — 401 + no DB write on failure
 *  3. Single transaction:
 *     a. INSERT webhook_events ON CONFLICT DO NOTHING
 *     b. If new row: INSERT outbox row
 *  4. Return result (controller always responds 200)
 */
export async function ingestWebhook(
  zapId: string,
  stepId: string,
  rawBody: Buffer,
  signature: string,
  eventId: string,
): Promise<IngestResult> {
  // 1. Look up the trigger step to get the webhook secret
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

  if (!step || !step.webhookSecret) {
    logger.warn({ zapId, stepId }, 'webhook not found or missing secret');
    return { status: 'not_found' };
  }

  // 2. HMAC verification — reject with no DB write on failure
  const valid = verifyWebhook(rawBody, signature, step.webhookSecret);
  if (!valid) {
    logger.warn({ zapId, stepId, eventId }, 'HMAC verification failed');
    return { status: 'unauthorized' };
  }

  // Parse body (safe now — verification passed)
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    payload = { raw: rawBody.toString('utf8') };
  }

  // 3. Atomic transaction: webhook_events + outbox
  const result = await prisma.$transaction(async (tx) => {
    // INSERT ... ON CONFLICT (event_id, zap_id) DO NOTHING RETURNING id
    // Prisma doesn't support ON CONFLICT DO NOTHING natively, so we use $queryRaw
    const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO webhook_events (event_id, zap_id, payload)
      VALUES (${eventId}, ${BigInt(zapId)}, ${payload}::jsonb)
      ON CONFLICT (event_id, zap_id) DO NOTHING
      RETURNING id
    `;

    // If no row returned — already ingested (duplicate event_id). Still 200.
    if (rows.length === 0) {
      logger.info({ zapId, stepId, eventId }, 'duplicate webhook event — skipping outbox write');
      return 'duplicate';
    }

    const webhookEventId = rows[0].id;

    // Insert outbox row — relay will pick this up
    await tx.outbox.create({
      data: {
        webhookEventId,
        eventId,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    logger.info({ zapId, stepId, eventId, webhookEventId: webhookEventId.toString() }, 'webhook ingested and outbox row created');
    return 'ingested';
  });

  return { status: result as 'ingested' | 'duplicate' };
}
