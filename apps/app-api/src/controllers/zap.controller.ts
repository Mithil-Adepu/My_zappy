import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '@zapier-clone/db';
import { createError } from '../middleware/error-handler.middleware';
import { validateZapSteps } from '../services/zap-validation.service';
import { assertConnectionOwnership } from '../services/connection-ownership.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { serializeBigInt } from '../lib/serialize';

/** Type of the interactive client inside a prisma.$transaction callback. */
type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// ─── Schema helpers ───────────────────────────────────────────────────────────

const stepSchema = z.object({
  stepType: z.enum(['trigger', 'action', 'filter']),
  position: z.number().int().min(0),
  availableTriggerId: z.string().optional().nullable(),
  availableActionId: z.string().optional().nullable(),
  connectionId: z.string().optional().nullable(),
  config: z.record(z.unknown()).default({}),
});

const createZapSchema = z.object({
  name: z.string().min(1).max(200),
  isActive: z.boolean().default(true),
  maxRunsPerHour: z.number().int().min(1).max(10000).default(100),
  steps: z.array(stepSchema).min(1),
});



// ─── List zaps ────────────────────────────────────────────────────────────────

export async function listZaps(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zaps = await prisma.zap.findMany({
      where: { userId },
      include: { _count: { select: { steps: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(zaps.map(serializeBigInt));
  } catch (err) {
    next(err);
  }
}

// ─── Get zap ─────────────────────────────────────────────────────────────────

export async function getZap(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zapId = BigInt(req.params.id);

    const zap = await prisma.zap.findFirst({
      where: { id: zapId, userId },
      include: {
        steps: {
          orderBy: { position: 'asc' },
          include: {
            availableTrigger: true,
            availableAction: true,
          },
        },
      },
    });

    if (!zap) throw createError('Zap not found', 404);
    res.json(serializeBigInt(zap as unknown as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
}

// ─── Create zap ───────────────────────────────────────────────────────────────

export async function createZap(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const body = createZapSchema.parse(req.body);

    validateZapSteps(body.steps);

    // Validate connection ownership for every step that specifies one
    for (const step of body.steps) {
      if (step.connectionId) {
        await assertConnectionOwnership(BigInt(step.connectionId), userId);
      }
    }

    const zap = await prisma.zap.create({
      data: {
        userId,
        name: body.name,
        isActive: body.isActive,
        maxRunsPerHour: body.maxRunsPerHour,
        steps: {
          create: body.steps.map((step) => ({
            stepType: step.stepType,
            position: step.position,
            availableTriggerId: step.availableTriggerId,
            availableActionId: step.availableActionId,
            connectionId: step.connectionId ? BigInt(step.connectionId) : null,
            config: step.config as object,
            // Generate webhook secret for trigger steps
            webhookSecret:
              step.stepType === 'trigger'
                ? crypto.randomBytes(32).toString('hex')
                : null,
          })),
        },
      },
      include: {
        steps: { orderBy: { position: 'asc' } },
      },
    });

    res.status(201).json(serializeBigInt(zap as unknown as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
}

// ─── Update zap ───────────────────────────────────────────────────────────────

export async function updateZap(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zapId = BigInt(req.params.id);

    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        isActive: z.boolean().optional(),
        maxRunsPerHour: z.number().int().min(1).max(10000).optional(),
      })
      .parse(req.body);

    const existing = await prisma.zap.findFirst({
      where: { id: zapId, userId },
    });
    if (!existing) throw createError('Zap not found', 404);

    const zap = await prisma.zap.update({
      where: { id: zapId },
      data: body,
    });

    res.json(serializeBigInt(zap as unknown as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
}

// ─── Delete zap ───────────────────────────────────────────────────────────────

export async function deleteZap(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zapId = BigInt(req.params.id);

    const existing = await prisma.zap.findFirst({
      where: { id: zapId, userId },
    });
    if (!existing) throw createError('Zap not found', 404);

    await prisma.zap.delete({ where: { id: zapId } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ─── Add step ─────────────────────────────────────────────────────────────────

export async function addStep(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zapId = BigInt(req.params.id);

    const existing = await prisma.zap.findFirst({
      where: { id: zapId, userId },
      include: { steps: true },
    });
    if (!existing) throw createError('Zap not found', 404);

    const body = stepSchema.parse(req.body);

    if (body.connectionId) {
      await assertConnectionOwnership(BigInt(body.connectionId), userId);
    }

    // Validate full step set after adding new step
    const newStepSet = [
      ...existing.steps,
      { ...body, connectionId: body.connectionId ?? null },
    ];
    validateZapSteps(newStepSet);

    const step = await prisma.zapStep.create({
      data: {
        zapId,
        stepType: body.stepType,
        position: body.position,
        availableTriggerId: body.availableTriggerId,
        availableActionId: body.availableActionId,
        connectionId: body.connectionId ? BigInt(body.connectionId) : null,
        config: body.config as object,
        webhookSecret:
          body.stepType === 'trigger'
            ? crypto.randomBytes(32).toString('hex')
            : null,
      },
    });

    res.status(201).json(serializeBigInt(step as unknown as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
}

// ─── Update step ─────────────────────────────────────────────────────────────

export async function updateStep(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zapId = BigInt(req.params.id);
    const stepId = BigInt(req.params.stepId);

    const zap = await prisma.zap.findFirst({ where: { id: zapId, userId } });
    if (!zap) throw createError('Zap not found', 404);

    // Security: verify the step actually belongs to this zap (prevents IDOR)
    const existingStep = await prisma.zapStep.findFirst({
      where: { id: stepId, zapId },
    });
    if (!existingStep) throw createError('Step not found', 404);

    const body = z
      .object({
        config: z.record(z.unknown()).optional(),
        connectionId: z.string().nullable().optional(),
      })
      .parse(req.body);

    if (body.connectionId) {
      await assertConnectionOwnership(BigInt(body.connectionId), userId);
    }

    const step = await prisma.zapStep.update({
      where: { id: stepId },
      data: {
        ...(body.config && { config: body.config as object }),
        ...(body.connectionId !== undefined && {
          connectionId: body.connectionId ? BigInt(body.connectionId) : null,
        }),
      },
    });

    res.json(serializeBigInt(step as unknown as Record<string, unknown>));
  } catch (err) {
    next(err);
  }
}

// ─── Delete step ─────────────────────────────────────────────────────────────

export async function deleteStep(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const zapId = BigInt(req.params.id);
    const stepId = BigInt(req.params.stepId);

    const zap = await prisma.zap.findFirst({
      where: { id: zapId, userId },
      include: { steps: true },
    });
    if (!zap) throw createError('Zap not found', 404);

    const stepToDelete = zap.steps.find((s) => s.id === stepId);
    if (!stepToDelete) throw createError('Step not found', 404);

    await prisma.$transaction(async (tx: PrismaTx) => {
      await tx.zapStep.delete({ where: { id: stepId } });

      // Re-sequence positions — fill gap left by deleted step
      const remaining = zap.steps
        .filter((s) => s.id !== stepId)
        .sort((a, b) => a.position - b.position);

      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].position !== i) {
          await tx.zapStep.update({
            where: { id: remaining[i].id },
            data: { position: i },
          });
        }
      }
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

