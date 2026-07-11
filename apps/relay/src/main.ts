import express from 'express';
import { env } from './config/env';
import { pollOutbox, requestStop } from './poller/outbox-poller';
import { disconnectProducer, getKafka } from './kafka/producer';
import { prisma } from '@zapier-clone/db';

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
  console.log('[relay] SIGTERM received — finishing in-flight poll before exit');
  requestStop();

  if (currentPollPromise) {
    await currentPollPromise;
  }

  await disconnectProducer();
  await prisma.$disconnect();
  console.log('[relay] Shutdown complete');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[relay] SIGINT received');
  requestStop();
  await disconnectProducer();
  await prisma.$disconnect();
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.RELAY_HEALTH_PORT ? parseInt(process.env.RELAY_HEALTH_PORT) : 3003;

app.listen(PORT, () => {
  console.log(`🔁  relay health endpoint on port ${PORT}`);
});

console.log('🔁  relay starting outbox poll loop...');
currentPollPromise = pollOutbox();
