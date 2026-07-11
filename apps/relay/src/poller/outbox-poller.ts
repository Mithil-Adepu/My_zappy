import { prisma } from '@zapier-clone/db';
import { getProducer } from '../kafka/producer';
import { env } from '../config/env';
import { ZapRunRequestedEvent } from '@zapier-clone/types';

interface OutboxRow {
  id: bigint;
  webhookEventId: bigint;
  eventId: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  // joined from webhook_events
  zapId: bigint;
  userId: bigint;
}

let isRunning = false;
let stopRequested = false;

/**
 * Polls the outbox for pending rows, publishes them to Kafka, marks dispatched.
 * Uses FOR UPDATE SKIP LOCKED so multiple relay instances can run safely.
 *
 * Flow (design doc §7):
 *  SELECT pending FOR UPDATE SKIP LOCKED
 *  → produce to Kafka (partition key = user_id for blast radius isolation)
 *  → on ack: mark dispatched
 *  → on failure: increment attempts or mark dead at max_attempts
 */
export async function pollOutbox(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  while (!stopRequested) {
    try {
      // FOR UPDATE SKIP LOCKED — safe for concurrent relay instances
      const rows = await prisma.$queryRaw<OutboxRow[]>`
        SELECT
          o.id,
          o.webhook_event_id AS "webhookEventId",
          o.event_id AS "eventId",
          o.payload,
          o.attempts,
          o.max_attempts AS "maxAttempts",
          we.zap_id AS "zapId",
          z.user_id AS "userId"
        FROM outbox o
        JOIN webhook_events we ON we.id = o.webhook_event_id
        JOIN zaps z ON z.id = we.zap_id
        WHERE o.status = 'pending'
        ORDER BY o.created_at
        LIMIT ${env.RELAY_BATCH_SIZE}
        FOR UPDATE OF o SKIP LOCKED
      `;

      for (const row of rows) {
        await processRow(row);
      }
    } catch (err) {
      console.error('[relay] Poll error:', err);
    }

    // Wait before next sweep
    await sleep(env.RELAY_POLL_INTERVAL_MS);
  }

  isRunning = false;
}

async function processRow(row: OutboxRow): Promise<void> {
  const producer = await getProducer();

  const event: ZapRunRequestedEvent = {
    webhookEventId: row.webhookEventId.toString(),
    zapId: row.zapId.toString(),
    userId: row.userId.toString(),
    payload: row.payload as Record<string, unknown>,
    receivedAt: new Date().toISOString(),
  };

  try {
    await producer.send({
      topic: env.KAFKA_TOPIC_ZAP_RUN_REQUESTED,
      messages: [
        {
          // Partition key = user_id — bounds blast radius per tenant
          key: row.userId.toString(),
          value: JSON.stringify(event),
        },
      ],
    });

    // Kafka ack received — mark dispatched
    await prisma.outbox.update({
      where: { id: row.id },
      data: {
        status: 'dispatched',
        attempts: { increment: 1 },
      },
    });

    console.log(`[relay] Dispatched outbox row ${row.id} (event: ${row.eventId})`);
  } catch (err) {
    console.error(`[relay] Failed to dispatch row ${row.id}:`, err);

    const newAttempts = row.attempts + 1;
    if (newAttempts >= row.maxAttempts) {
      // Dead-letter — requires manual intervention
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: 'dead', attempts: newAttempts },
      });
      console.error(
        `[relay] Row ${row.id} moved to dead after ${newAttempts} attempts. MANUAL REVIEW REQUIRED.`,
      );
    } else {
      // Stay pending, retry next sweep
      await prisma.outbox.update({
        where: { id: row.id },
        data: { attempts: newAttempts },
      });
    }
  }
}

export function requestStop(): void {
  stopRequested = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
