import { prisma } from '@zapier-clone/db';
import { getProducer } from '../kafka/producer';
import { env } from '../config/env';
import { ZapRunRequestedEvent } from '@zapier-clone/types';
import { logger } from '../lib/logger';

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
      /**
       * IMPORTANT: FOR UPDATE SKIP LOCKED requires a transaction to hold the lock.
       * We claim rows inside the transaction (marking them 'dispatched' optimistically),
       * then produce to Kafka outside. If Kafka fails, we revert to 'pending' in the catch.
       * This is the "optimistic claim" pattern for the outbox.
       */
      const claimedRows = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
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
          ORDER BY o.created_at ASC
          LIMIT ${env.RELAY_BATCH_SIZE}
          FOR UPDATE OF o SKIP LOCKED
        `;

        if (rows.length === 0) return [];

        // Optimistically mark as dispatched inside the transaction
        const ids = rows.map((r) => r.id);
        await tx.$executeRaw`
          UPDATE outbox
          SET status = 'dispatched', attempts = attempts + 1
          WHERE id = ANY(${ids}::bigint[])
        `;

        return rows;
      });

      // Produce to Kafka outside the transaction (Kafka is not 2PC-compatible)
      await Promise.all(claimedRows.map((row) => produceRow(row)));
    } catch (err) {
      logger.error({ err }, '[relay] Poll error');
    }

    // Wait before next sweep
    await sleep(env.RELAY_POLL_INTERVAL_MS);
  }

  isRunning = false;
}


async function produceRow(row: OutboxRow): Promise<void> {
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

    logger.info({ outboxRowId: row.id.toString(), eventId: row.eventId }, '[relay] Dispatched outbox row');
  } catch (err) {
    logger.error({ err, outboxRowId: row.id.toString() }, '[relay] Failed to produce to Kafka — reverting status');

    // Row was already marked dispatched in the transaction; revert on Kafka failure
    const newAttempts = row.attempts + 1;
    if (newAttempts >= row.maxAttempts) {
      // Dead-letter — requires manual intervention
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: 'dead', attempts: newAttempts },
      });
      logger.error(
        { outboxRowId: row.id.toString(), attempts: newAttempts },
        '[relay] Row moved to dead after max attempts — MANUAL REVIEW REQUIRED',
      );
    } else {
      // Revert to pending so next sweep retries
      await prisma.outbox.update({
        where: { id: row.id },
        data: { status: 'pending', attempts: newAttempts },
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
