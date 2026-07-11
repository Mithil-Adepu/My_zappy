import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { authRouter } from './routes/auth.routes';
import { connectorsRouter } from './routes/connectors.routes';
import { connectionsRouter } from './routes/connections.routes';
import { zapsRouter } from './routes/zaps.routes';
import { runsRouter } from './routes/runs.routes';
import { errorHandler } from './middleware/error-handler.middleware';
import { startCronJobs } from './jobs';

export const app = express();

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const { prisma } = await import('@zapier-clone/db');
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: true });
  } catch {
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
  app.listen(env.APP_API_PORT, () => {
    console.log(`🚀  app-api running on port ${env.APP_API_PORT}`);
  });
}
