// Sentry must be initialised before any other imports
import { initSentry, Sentry } from './lib/sentry';
initSentry();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { prisma } from '@zapier-clone/db';
import { env } from './config/env';
import { authRouter } from './routes/auth.routes';
import { connectorsRouter } from './routes/connectors.routes';
import { connectionsRouter } from './routes/connections.routes';
import { zapsRouter } from './routes/zaps.routes';
import { runsRouter } from './routes/runs.routes';
import { errorHandler } from './middleware/error-handler.middleware';
import { requestLogger } from './middleware/request-logger.middleware';
import { startCronJobs } from './jobs';
import { logger } from './lib/logger';


export const app: import('express').Express = express();

// Trust one proxy hop (Nginx) so express-rate-limit can read the real
// client IP from X-Forwarded-For instead of the Docker bridge IP.
app.set('trust proxy', 1);

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: env.WEB_APP_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

// ─── Global rate limiter ─────────────────────────────────────────────────────
// Defense-in-depth: 200 req/min per IP across all routes.
// Auth routes (/auth/login, /auth/signup) have their own tighter 10/15min limiter.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(globalLimiter);


// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const { prisma } = await import('@zapier-clone/db');
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true });
  } catch (err) {
    logger.error({ err }, '[app-api] Health check failed');
    res.status(503).json({ status: 'error', db: false });
  }
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/connectors', connectorsRouter);
app.use('/connections', connectionsRouter);
app.use('/zaps', zapsRouter);
app.use('/runs', runsRouter);

// ─── Error Handler (must be last) ────────────────────────────────────────────
app.use(errorHandler);

// ─── Server ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  startCronJobs();
  const server = app.listen(env.APP_API_PORT, () => {
    logger.info({ port: env.APP_API_PORT }, '🚀  app-api running');
  });

  // ─── Graceful shutdown (§16) ───────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`[app-api] ${signal} received — draining connections`);
    server.close(async () => {
      await Sentry.flush(2000).catch(() => {});
      await prisma.$disconnect();
      logger.info('[app-api] Shutdown complete');
      process.exit(0);
    });

    // Force-exit after 30 s if drain takes too long
    setTimeout(() => {
      logger.warn('[app-api] Forced exit after 30 s shutdown timeout');
      process.exit(1);
    }, 30_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}
