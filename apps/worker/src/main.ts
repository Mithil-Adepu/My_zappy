import express from 'express';
import { prisma } from '@zapier-clone/db';
import { env } from './config/env';
import { initSentry } from './lib/sentry';
import { startConsumer, pauseConsumer, disconnectConsumer } from './consumer/run-consumer';
import { disconnectRedis } from './services/rate-limiter.service';
import { registerAdapter } from './connectors/registry';
import { slackSendMessageAdapter } from './connectors/slack/actions/send-message';
import { razorpayCreatePaymentAdapter } from './connectors/razorpay/actions/create-payment';
import { logger } from './lib/logger';

// Sentry must be initialised before any async code runs
initSentry();


// ─── Register all connector adapters ─────────────────────────────────────────
registerAdapter(slackSendMessageAdapter);
registerAdapter(razorpayCreatePaymentAdapter);
logger.info('✅  Connector adapters registered: slack, razorpay');

// ─── Health endpoint ──────────────────────────────────────────────────────────
const app = express();

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true });
  } catch {
    res.status(503).json({ status: 'error', db: false });
  }
});

const HEALTH_PORT = process.env.WORKER_HEALTH_PORT
  ? parseInt(process.env.WORKER_HEALTH_PORT)
  : 3004;

app.listen(HEALTH_PORT, () => {
  logger.info({ port: HEALTH_PORT }, '🔧  worker health endpoint started');
});

// ─── Graceful shutdown (§16) ──────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('[worker] SIGTERM received — finishing in-flight step before exit');
  await pauseConsumer();

  // Give in-flight step a moment to finish
  await new Promise((resolve) => setTimeout(resolve, 5000));

  await disconnectConsumer();
  await disconnectRedis();
  await prisma.$disconnect();
  logger.info('[worker] Shutdown complete');
  process.exit(0);
});

process.on('SIGINT', async () => {
  await disconnectConsumer();
  await disconnectRedis();
  await prisma.$disconnect();
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────
startConsumer().catch((err) => {
  logger.error({ err }, '[worker] Fatal error starting consumer');
  process.exit(1);
});

