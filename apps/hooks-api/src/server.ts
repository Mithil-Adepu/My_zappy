import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
  if (req.path !== '/health') {
    logger.info({ method: req.method, url: req.url }, 'incoming request');
  }
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

// Rate limiter: 300 requests/min per IP on webhook ingestion endpoint
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' },
});

// Webhook receiver (5MB body limit handled in rawBodyMiddleware)
app.use('/hooks', webhookLimiter, webhookRouter);

// ─── Global Error Handler ────────────────────────────────────────────────────
// Catches any thrown error in route handlers that wasn't caught internally
app.use((err: Error & { statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const statusCode = err.statusCode ?? 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;
  logger.error({ err, statusCode }, '[hooks-api] unhandled error');
  res.status(statusCode).json({ error: message });
});


if (require.main === module) {
  app.listen(env.HOOKS_API_PORT, () => {
    logger.info({ port: env.HOOKS_API_PORT }, '🪝  hooks-api started');
  });
}
