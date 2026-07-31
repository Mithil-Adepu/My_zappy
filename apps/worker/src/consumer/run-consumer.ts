import { Kafka, Consumer } from 'kafkajs';
import { prisma } from '@zapier-clone/db';
import { env } from '../config/env';
import { ZapRunRequestedEvent } from '@zapier-clone/types';
import { resume } from '../engine/sequential-executor';
import { underRunCap } from '../services/rate-limiter.service';
import { logger } from '../lib/logger';

let consumer: Consumer | null = null;
let shuttingDown = false;

export function getConsumer(): Consumer {
  if (!consumer) {
    const kafka = new Kafka({
      clientId: env.KAFKA_CLIENT_ID,
      brokers: env.KAFKA_BROKERS.split(','),
      // Increase retries — broker can be slow on first start in KRaft mode.
      // initialRetryTime + exponential backoff prevents rapid hammering.
      retry: { initialRetryTime: 300, retries: 10 },
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
  // IMPORTANT: json_build_object keys must be camelCase to match SnapshotStep interface
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
          'stepType', zs.step_type,
          'availableActionId', zs.available_action_id,
          'availableTriggerId', zs.available_trigger_id,
          'connectionId', zs.connection_id,
          'config', zs.config,
          'availableAction', (
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
      logger.error({ webhookEventId: event.webhookEventId }, '[worker] Cannot find run for webhookEventId');
      return;
    }

    // If already terminal, skip
    if (['completed', 'failed', 'filtered'].includes(existing.status)) {
      logger.info({ webhookEventId: event.webhookEventId, status: existing.status }, '[worker] Run already terminal — skipping');
      return;
    }

    zapRun = { id: existing.id, stepSnapshot: existing.stepSnapshot };
  }

  // Mark outbox consumed
  await prisma.outbox.updateMany({
    where: { webhookEventId },
    data: { status: 'consumed', consumedAt: new Date() },
  });

  // §11 — Enforce per-zap hourly run cap (maxRunsPerHour stored on Zap)
  const zap = await prisma.zap.findUnique({
    where: { id: zapId },
    select: { maxRunsPerHour: true, isActive: true },
  });

  if (!zap || !zap.isActive) {
    logger.info({ zapId: zapId.toString() }, '[worker] Zap is inactive — skipping run');
    return;
  }

  const underCap = await underRunCap(zapId, zap.maxRunsPerHour);
  if (!underCap) {
    logger.warn({ zapId: zapId.toString(), maxRunsPerHour: zap.maxRunsPerHour }, '[worker] Zap exceeded maxRunsPerHour — run skipped');
    await prisma.zapRun.update({
      where: { id: zapRun.id },
      data: { status: 'failed', completedAt: new Date() },
    });
    return;
  }

  // Execute sequentially
  const payloadContext = event.payload;
  await resume(
    { id: zapRun.id, zapId, stepSnapshot: zapRun.stepSnapshot },
    payloadContext,
  );
}

const CONNECT_MAX_ATTEMPTS = 20;

/**
 * Connects and subscribes with exponential backoff.
 * Kafka (KRaft mode) can take 30-60s to elect a leader and create topics
 * on first start. Rather than crashing, the worker retries automatically.
 */
async function connectWithRetry(c: Consumer): Promise<void> {
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      await c.connect();
      await c.subscribe({
        topic: env.KAFKA_TOPIC_ZAP_RUN_REQUESTED,
        fromBeginning: false,
      });
      logger.info({ attempt }, '[worker] Kafka connected and subscribed');
      return;
    } catch (err) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000); // 1s → 30s cap
      logger.warn(
        { err, attempt, nextRetryMs: delay },
        `[worker] Kafka connect attempt ${attempt}/${CONNECT_MAX_ATTEMPTS} failed — retrying in ${delay}ms`,
      );
      if (attempt === CONNECT_MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function startConsumer(): Promise<void> {
  const c = getConsumer();
  await connectWithRetry(c);

  await c.run({
    // TASK-3.6: Use eachBatch so we can call heartbeat() during long-running
    // message processing. eachMessage blocks the heartbeat for the full
    // duration of the handler, causing session timeouts on complex zaps.
    autoCommit: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
      for (const message of batch.messages) {
        if (shuttingDown) break;
        if (!message.value) {
          resolveOffset(message.offset);
          await heartbeat();
          continue;
        }

        try {
          const event = JSON.parse(message.value.toString()) as ZapRunRequestedEvent;
          await onMessage(event);
        } catch (err) {
          logger.error({ err }, '[worker] Error processing message');
        }

        resolveOffset(message.offset);
        // Heartbeat after each message to prevent session timeout
        await heartbeat();
      }
      await commitOffsetsIfNecessary();
    },
  });

  logger.info('✅  Kafka consumer running');
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
