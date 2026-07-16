import express from 'express';
import { env } from './config/env';
import { initSentry } from './lib/sentry';
import { pollOutbox, requestStop } from './poller/outbox-poller';
import { disconnectProducer } from './kafka/producer';
import { prisma } from '@zapier-clone/db';
import { logger } from './lib/logger';

// Sentry must be initialised before any async code runs
initSentry();

// Minimal Express app just for the /health endpoint
// relay has no other HTTP surface — it's a pure background process
const app = express();

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true });
  } catch {
    res.status(503).json({ status: 'error', db: false });
  }
});

// ─── Graceful shutdown (§16) ──────────────────────────────────────────────────
let currentPollPromise: Promise<void> | null = null;

process.on('SIGTERM', async () => {
  logger.info('[relay] SIGTERM received — finishing in-flight poll before exit');
  requestStop();

  if (currentPollPromise) {
    await currentPollPromise;
  }

  await disconnectProducer();
  await prisma.$disconnect();
  logger.info('[relay] Shutdown complete');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('[relay] SIGINT received — finishing in-flight poll before exit');
  requestStop();

  if (currentPollPromise) {
    await currentPollPromise;
  }

  await disconnectProducer();
  await prisma.$disconnect();
  logger.info('[relay] Shutdown complete');
  process.exit(0);
});


// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = env.RELAY_HEALTH_PORT;

app.listen(PORT, () => {
  logger.info({ port: PORT }, '🔁  relay health endpoint started');
});

logger.info('🔁  relay starting outbox poll loop...');
currentPollPromise = pollOutbox();
