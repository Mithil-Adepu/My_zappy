import { Request, Response, NextFunction } from 'express';
import { prisma } from '@zapier-clone/db';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { createError } from '../middleware/error-handler.middleware';
import { serializeBigInt } from '../lib/serialize';


// GET /runs/zap/:zapId — paginated run list for a zap
export async function listRunsForZap(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zapId = BigInt(req.params.zapId);
    const rawPage = Array.isArray(req.query.page) ? '1' : String(req.query.page ?? '1');
    const rawLimit = Array.isArray(req.query.limit) ? '20' : String(req.query.limit ?? '20');
    const page = parseInt(rawPage, 10) || 1;
    const limit = Math.min(parseInt(rawLimit, 10) || 20, 100);

    // Verify zap ownership before returning run data
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
}

// GET /runs/:runId — full run detail with all steps
export async function getRun(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
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
}
