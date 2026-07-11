import { Kafka, Consumer } from 'kafkajs';
import { prisma } from '@zapier-clone/db';
import { env } from '../config/env';
import { ZapRunRequestedEvent } from '@zapier-clone/types';
import { resume } from '../engine/sequential-executor';

let consumer: Consumer | null = null;
let shuttingDown = false;

export function getConsumer(): Consumer {
  if (!consumer) {
    const kafka = new Kafka({
      clientId: env.KAFKA_CLIENT_ID,
      brokers: env.KAFKA_BROKERS.split(','),
      retry: { retries: 5 },
    });
    consumer = kafka.consumer({ groupId: env.KAFKA_GROUP_ID_WORKER });
  }
  return consumer;
}

/**
 * Processes a single Kafka message.
 * Implements design doc §9.1:
 *  1. INSERT INTO zap_runs ON CONFLICT DO NOTHING (idempotent)
 *  2. Fetch or use existing run
 *  3. Mark outbox consumed
 *  4. Resume sequential execution
 */
export async function onMessage(event: ZapRunRequestedEvent): Promise<void> {
  if (shuttingDown) return;

  const webhookEventId = BigInt(event.webhookEventId);
  const zapId = BigInt(event.zapId);

  // Upsert zap_run — ON CONFLICT DO NOTHING (idempotent on Kafka redeliver)
  const rows = await prisma.$queryRaw<Array<{ id: bigint; step_snapshot: unknown }>>`
    INSERT INTO zap_runs (zap_id, webhook_event_id, status, step_snapshot)
    SELECT
      ${zapId},
      ${webhookEventId},
      'in_progress',
      (SELECT json_agg(
        json_build_object(
          'id', zs.id,
          'position', zs.position,
          'step_type', zs.step_type,
          'available_action_id', zs.available_action_id,
          'available_trigger_id', zs.available_trigger_id,
          'connection_id', zs.connection_id,
          'config', zs.config,
          'available_action', (
            SELECT json_build_object('inputSchema', aa.input_schema)
            FROM available_actions aa WHERE aa.id = zs.available_action_id
          )
        ) ORDER BY zs.position
      ) FROM zap_steps zs WHERE zs.zap_id = ${zapId})
    ON CONFLICT (webhook_event_id) DO NOTHING
    RETURNING id, step_snapshot
  `;

  let zapRun: { id: bigint; stepSnapshot: unknown };

  if (rows.length > 0) {
    zapRun = { id: rows[0].id, stepSnapshot: rows[0].step_snapshot };
  } else {
    // Run already exists (Kafka redeliver) — fetch it
    const existing = await prisma.zapRun.findUnique({
      where: { webhookEventId },
      select: { id: true, stepSnapshot: true, status: true },
    });

    if (!existing) {
      console.error(`[worker] Cannot find run for webhookEventId ${webhookEventId}`);
      return;
    }

    // If already terminal, skip
    if (['completed', 'failed', 'filtered'].includes(existing.status)) {
      console.log(`[worker] Run for event ${event.webhookEventId} already terminal (${existing.status}), skipping`);
      return;
    }

    zapRun = { id: existing.id, stepSnapshot: existing.stepSnapshot };
  }

  // Mark outbox consumed
  await prisma.outbox.updateMany({
    where: { webhookEventId },
    data: { status: 'consumed', consumedAt: new Date() },
  });

  // Execute sequentially
  const payloadContext = event.payload;
  await resume(
    { id: zapRun.id, zapId, stepSnapshot: zapRun.stepSnapshot },
    payloadContext,
  );
}

export async function startConsumer(): Promise<void> {
  const c = getConsumer();
  await c.connect();
  await c.subscribe({
    topic: env.KAFKA_TOPIC_ZAP_RUN_REQUESTED,
    fromBeginning: false,
  });

  await c.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      try {
        const event = JSON.parse(message.value.toString()) as ZapRunRequestedEvent;
        await onMessage(event);
      } catch (err) {
        console.error('[worker] Error processing message:', err);
      }
    },
  });

  console.log('✅  Kafka consumer running');
}

export async function pauseConsumer(): Promise<void> {
  consumer?.pause([{ topic: env.KAFKA_TOPIC_ZAP_RUN_REQUESTED }]);
}

export async function disconnectConsumer(): Promise<void> {
  shuttingDown = true;
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
  }
}
