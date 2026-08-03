import express from 'express';
import cron from 'node-cron';
import { prisma } from '@zapier-clone/db';
import { env } from './config/env';
import { initSentry } from './lib/sentry';
import { startConsumer, pauseConsumer, disconnectConsumer, isConsumerHealthy } from './consumer/run-consumer';
import { disconnectRedis } from './services/rate-limiter.service';
import { retryStuckSteps } from './services/retry-stuck-steps.job';
// registry.ts self-registers all adapters (slack, razorpay, github) at module load time
// via its top-level registerAdapter() calls. No duplicate calls needed here.
import './connectors/registry';
import { logger } from './lib/logger';

// Sentry must be initialised before any async code runs
initSentry();

logger.info('✅  Connector adapters registered: slack, razorpay, github');

// ─── Health endpoint ──────────────────────────────────────────────────────────
const app = express();

app.get('/health', async (_req, res) => {
  try {
    if (!isConsumerHealthy) {
      logger.error('[worker] Health check failed: Kafka consumer is unhealthy');
      res.status(503).json({ status: 'error', kafka: false });
      return;
    }
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true, kafka: true });
  } catch (err) {
    logger.error({ err }, '[worker] Health check failed: DB error');
    res.status(503).json({ status: 'error', db: false });
  }
});

const HEALTH_PORT = env.WORKER_HEALTH_PORT;

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

// ─── Retry stuck steps cron (every 2 minutes) ─────────────────────────────────
// Rate-limited steps return 'processing' and exit. Without this cron they stay
// stuck indefinitely. Matches the RETRY_AFTER_MINUTES constant in the job file.
cron.schedule('*/2 * * * *', async () => {
  try {
    await retryStuckSteps();
  } catch (err) {
    logger.error({ err }, '[worker] retryStuckSteps cron failed');
  }
});

logger.info('✅  retryStuckSteps cron scheduled (every 2 minutes)');
