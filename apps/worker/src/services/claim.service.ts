import { prisma } from '@zapier-clone/db';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

export interface ClaimedStep {
  id: bigint;
  zapRunId: bigint;
  zapStepId: bigint;
  idempotencyKey: string;
  workerId: string;
}

/**
 * Attempts to claim a step for this worker.
 *
 * Returns:
 *  - ClaimedStep if successfully claimed (new or re-claimed after lease timeout)
 *  - null if already done, or actively owned by another worker
 *
 * Design doc §9.3: reclaim() never re-executes — marks ambiguous, halts run.
 */
export async function claim(
  zapRunId: bigint,
  zapStepId: bigint,
): Promise<ClaimedStep | null> {
  // INSERT ... ON CONFLICT DO NOTHING RETURNING — not supported natively in Prisma
  const rows = await prisma.$queryRaw<ClaimedStep[]>`
    INSERT INTO zap_run_steps (zap_run_id, zap_step_id, status, claimed_at, worker_id)
    VALUES (${zapRunId}, ${zapStepId}, 'processing', now(), ${WORKER_ID})
    ON CONFLICT (zap_run_id, zap_step_id) DO NOTHING
    RETURNING id, zap_run_id AS "zapRunId", zap_step_id AS "zapStepId",
              idempotency_key::text AS "idempotencyKey", worker_id AS "workerId"
  `;

  if (rows.length > 0) {
    // Fresh claim — we own it
    return rows[0];
  }

  // Conflict — check existing row
  const existing = await prisma.zapRunStep.findUnique({
    where: { zapRunId_zapStepId: { zapRunId, zapStepId } },
  });

  if (!existing) return null;

  if (existing.status === 'completed') {
    // Already done — safe no-op
    return null;
  }

  if (
    existing.status === 'processing' &&
    existing.claimedAt &&
    Date.now() - existing.claimedAt.getTime() > env.WORKER_LEASE_TIMEOUT_MS
  ) {
    // Lease expired — reclaim with ambiguous status
    return reclaim(existing.id);
  }

  // Actively owned by a live worker — back off
  return null;
}

/**
 * Lease expired — we don't know if the previous worker's call completed.
 * This is the ambiguous-outcome problem: do NOT re-execute.
 * Mark ambiguous and return null → run halts for manual review.
 */
async function reclaim(rowId: bigint): Promise<null> {
  await prisma.zapRunStep.update({
    where: { id: rowId },
    data: {
      status: 'ambiguous',
      errorCode: 'LEASE_EXPIRED',
      errorMessage:
        'Worker holding this step went silent past lease timeout. Outcome of the underlying call is unknown — do not assume it failed.',
    },
  });
  console.warn(
    `[worker] Step row ${rowId} marked ambiguous (lease expired). Requires manual review.`,
  );
  return null;
}

export async function markStepCompleted(
  claimedId: bigint,
  output: Record<string, unknown>,
): Promise<void> {
  await prisma.zapRunStep.update({
    where: { id: claimedId },
    data: { status: 'completed', output: output as Prisma.InputJsonValue },
  });
}

export async function recordStepResult(
  claimedId: bigint,
  result: { status: string; output?: Record<string, unknown>; errorCode?: string; errorMessage?: string },
): Promise<void> {
  await prisma.zapRunStep.update({
    where: { id: claimedId },
    data: {
      status: result.status,
      output: (result.output ?? null) as Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
    },
  });
}

export async function releaseWithDelay(claimedId: bigint): Promise<void> {
  // For rate-limited steps: reset status to allow retry on next worker pass.
  // The step stays 'processing' but claimedAt is bumped so the lease stays fresh.
  await prisma.zapRunStep.update({
    where: { id: claimedId },
    data: { claimedAt: new Date() },
  });
}
