import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { initSentry } from './lib/sentry';
import { webhookRouter } from './routes/webhook.routes';
import { logger } from './lib/logger';

// Sentry must be initialised before any async code runs
initSentry();


export const app: import('express').Express = express();

// NOTE: No express.json() here intentionally — rawBodyMiddleware captures raw bytes
// for HMAC verification. JSON parsing happens inside the service after verification.
app.use(helmet());

// Request logger middleware
app.use((req, _res, next) => {
  logger.info({ method: req.method, url: req.url }, 'incoming request');
  next();
});

// Health endpoint — no auth, no DB query needed here for speed
app.get('/health', async (_req, res) => {
  try {
    const { prisma } = await import('@zapier-clone/db');
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true });
  } catch {
    res.status(503).json({ status: 'error', db: false });
  }
});

// Webhook receiver
app.use('/hooks', webhookRouter);

if (require.main === module) {
  app.listen(env.HOOKS_API_PORT, () => {
    logger.info({ port: env.HOOKS_API_PORT }, '🪝  hooks-api started');
  });
}
