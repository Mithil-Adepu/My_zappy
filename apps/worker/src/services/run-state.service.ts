import { prisma } from '@zapier-clone/db';
import { logger } from '../lib/logger';

/**
 * Manages zap_runs terminal state transitions.
 * Every terminal branch in sequential-executor must call one of these.
 * Design doc §9.2 — no run left stuck at 'in_progress' forever.
 */

export async function markCompleted(zapRunId: bigint): Promise<void> {
  await prisma.zapRun.update({
    where: { id: zapRunId },
    data: { status: 'completed', completedAt: new Date() },
  });
  logger.info({ zapRunId: zapRunId.toString() }, '✅  run completed');
}

export async function markFiltered(zapRunId: bigint): Promise<void> {
  await prisma.zapRun.update({
    where: { id: zapRunId },
    data: { status: 'filtered', completedAt: new Date() },
  });
  logger.info({ zapRunId: zapRunId.toString() }, 'run filtered (filter step halted run)');
}

export async function markFailed(
  zapRunId: bigint,
  reason: string,
  stepId?: bigint,
): Promise<void> {
  await prisma.zapRun.update({
    where: { id: zapRunId },
    data: { status: 'failed', completedAt: new Date() },
  });
  logger.error(
    { zapRunId: zapRunId.toString(), reason, stepId: stepId?.toString() },
    'run failed',
  );
}
