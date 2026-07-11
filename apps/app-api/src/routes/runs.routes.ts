import { Router } from 'express';
import { Request, Response, NextFunction } from 'express';
import { prisma } from '@zapier-clone/db';
import { authMiddleware } from '../middleware/auth.middleware';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { createError } from '../middleware/error-handler.middleware';

export const runsRouter = Router();

runsRouter.use(authMiddleware);

function serializeBigInt(obj: unknown): unknown {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}

// GET /zaps/:zapId/runs — paginated run list for a zap
runsRouter.get('/zap/:zapId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zapId = BigInt(req.params.zapId);
    const page = parseInt((req.query.page as string) ?? '1');
    const limit = Math.min(parseInt((req.query.limit as string) ?? '20'), 100);

    // Verify zap ownership
    const zap = await prisma.zap.findFirst({ where: { id: zapId, userId } });
    if (!zap) throw createError('Zap not found', 404);

    const [runs, total] = await Promise.all([
      prisma.zapRun.findMany({
        where: { zapId },
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          _count: { select: { zapRunSteps: true } },
        },
      }),
      prisma.zapRun.count({ where: { zapId } }),
    ]);

    res.json(serializeBigInt({ runs, total, page, limit }));
  } catch (err) {
    next(err);
  }
});

// GET /runs/:runId — full run detail with all steps
runsRouter.get('/:runId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req as AuthenticatedRequest;
    const runId = BigInt(req.params.runId);

    const run = await prisma.zapRun.findFirst({
      where: {
        id: runId,
        zap: { userId },
      },
      include: {
        zapRunSteps: {
          orderBy: { executedAt: 'asc' },
          include: {
            zapStep: {
              include: {
                availableAction: { select: { name: true, connectorId: true } },
                availableTrigger: { select: { name: true, connectorId: true } },
              },
            },
          },
        },
      },
    });

    if (!run) throw createError('Run not found', 404);
    res.json(serializeBigInt(run));
  } catch (err) {
    next(err);
  }
});
