/**
 * Retry Stuck Steps Job (TASK-3.5)
 *
 * When a step is rate-limited, the step-runner returns `processing` and exits.
 * Without a re-trigger mechanism, the run stays `in_progress` indefinitely.
 *
 * This job queries for run_steps that have been in `processing` status for
 * longer than RETRY_AFTER_MINUTES and marks them as `failed` with a rate-limit
 * error code, then re-marks the zapRun as `in_progress` so an operator or
 * a relay re-trigger can resume it.
 *
 * Note: For full automatic retry, a relay-side job should re-enqueue the
 * zapRunId to Kafka. This worker-side job ensures runs don't get stuck silently.
 */
import { prisma } from '@zapier-clone/db';
import { logger } from '../lib/logger';

const RETRY_AFTER_MINUTES = 2;

export async function retryStuckSteps(): Promise<void> {
  const cutoff = new Date(Date.now() - RETRY_AFTER_MINUTES * 60 * 1000);

  // Find run_steps stuck in processing where claimed_at is old enough
  const stuckSteps = await prisma.zapRunStep.findMany({
    where: {
      status: 'processing',
      claimedAt: { lt: cutoff },
    },
    select: {
      id: true,
      zapRunId: true,
    },
    take: 50,
  });

  if (stuckSteps.length === 0) return;

  logger.info({ count: stuckSteps.length }, '[retry-stuck] Found stuck processing steps — resetting');

  // Reset stuck steps so sequential-executor can re-attempt them
  const ids = stuckSteps.map((s) => s.id);
  const zapRunIds = [...new Set(stuckSteps.map((s) => s.zapRunId))];

  await prisma.$transaction([
    // Reset stuck steps to 'failed' with a retry error code
    prisma.zapRunStep.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'failed',
        errorCode: 'RATE_LIMIT_RETRY',
        errorMessage: 'Retried after rate-limit window expired',
      },
    }),
    // Ensure affected runs are still marked in_progress (not accidentally terminal)
    prisma.zapRun.updateMany({
      where: { id: { in: zapRunIds }, status: 'in_progress' },
      data: { status: 'in_progress' },
    }),
  ]);

  logger.info({ stepIds: ids.map(String), zapRunIds: zapRunIds.map(String) }, '[retry-stuck] Reset stuck steps');
}

