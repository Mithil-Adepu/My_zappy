import { prisma } from '@zapier-clone/db';
import { claim, markStepCompleted, recordStepResult } from '../services/claim.service';
import { markCompleted, markFiltered, markFailed } from '../services/run-state.service';
import { evaluate as evaluateFilter } from '../engine/filter-evaluator';
import { runStep } from '../engine/step-runner';
import { logger } from '../lib/logger';

interface ZapRunWithSnapshot {
  id: bigint;
  zapId: bigint;
  stepSnapshot: unknown;
  payloadContext?: Record<string, unknown>;
}

interface SnapshotStep {
  id: bigint | string;
  position: number;
  stepType: 'trigger' | 'action' | 'filter';
  availableActionId: string | null;
  connectionId: bigint | string | null;
  config: Record<string, unknown>;
  availableAction?: { inputSchema: Record<string, unknown> | null } | null;
}

/**
 * Sequential executor — walks zap_steps by position, one at a time.
 * Implements design doc §9.2 exactly.
 *
 * Converted from recursion to iteration (B14 fix):
 * Recursive resume() was N-deep for N steps, risking stack overflow on long zaps.
 * Now uses a while loop with explicit loop control — identical semantics, O(1) stack.
 *
 * Every terminal branch explicitly calls a runState method.
 * No run is ever left stuck at in_progress forever.
 */
export async function resume(
  zapRun: ZapRunWithSnapshot,
  payloadContext: Record<string, unknown>,
): Promise<void> {
  const steps = (zapRun.stepSnapshot as SnapshotStep[]) ?? [];

  // Find the highest completed position to determine where to resume from
  const completedSteps = await prisma.zapRunStep.findMany({
    where: { zapRunId: zapRun.id, status: 'completed' },
    include: { zapStep: { select: { position: true } } },
  });

  const maxCompletedPosition =
    completedSteps.length > 0
      ? Math.max(...completedSteps.map((s: { zapStep: { position: number } }) => s.zapStep.position))
      : -1;

  let currentPosition = maxCompletedPosition + 1;
  let currentContext = payloadContext;

  // Iterative loop — replaces recursive resume() calls
  while (true) {
    const nextStep = steps.find((s) => s.position === currentPosition);

    if (!nextStep) {
      // All steps done — mark completed
      logger.info({ zapRunId: zapRun.id.toString() }, 'zap run completed successfully');
      await markCompleted(zapRun.id);
      return;
    }

    const stepId = BigInt(nextStep.id);
    const claimed = await claim(zapRun.id, stepId);

    if (!claimed) {
      // Owned elsewhere or already done — safe no-op
      return;
    }

    // ─── Trigger step ────────────────────────────────────────────────────────
    if (nextStep.stepType === 'trigger') {
      // The trigger already occurred (it's what started the run)
      await markStepCompleted(claimed.id, { result: 'Trigger successfully fired' });
      
      // Alias the webhook payload into step_1 so users can map {{step_1.payload...}}
      // Note: positions are 0-indexed in DB, but 1-indexed in UI
      currentContext = {
        ...currentContext,
        [`step_${currentPosition + 1}`]: payloadContext,
      };

      currentPosition++;
      continue;
    }

    // ─── Filter step ─────────────────────────────────────────────────────────
    if (nextStep.stepType === 'filter') {
      const passed = evaluateFilter(nextStep.config, currentContext);

      await markStepCompleted(claimed.id, { passed });

      if (!passed) {
        logger.info({ zapRunId: zapRun.id.toString(), stepId: stepId.toString() }, 'filter not matched — run marked filtered');
        await markFiltered(zapRun.id);
        return; // Terminal: filtered
      }

      // Filter passed — advance to next step
      currentPosition++;
      continue;
    }

    // ─── Action step ─────────────────────────────────────────────────────────
    const stepForRunner = {
      id: stepId,
      availableActionId: nextStep.availableActionId,
      connectionId: nextStep.connectionId ? BigInt(nextStep.connectionId) : null,
      config: nextStep.config,
      availableAction: nextStep.availableAction,
    };

    const result = await runStep(
      stepForRunner,
      currentContext,
      claimed.idempotencyKey,
      claimed.id,
    );

    await recordStepResult(claimed.id, result);

    if (result.status === 'completed') {
      // Merge step output into payload context for use by subsequent steps
      currentContext = {
        ...currentContext,
        [`step_${currentPosition + 1}`]: result.output ?? {},
      };
      currentPosition++;
      continue;
    }

    if (result.status === 'processing') {
      // Rate-limited — leave in processing, will retry via retry-stuck-steps job
      return;
    }

    // failed or ambiguous — explicitly terminate run
    if (result.status === 'ambiguous') {
      // §7.2.3 — Explicit alert on ambiguous step (SIGKILL mid-execution, non-idempotent connector)
      logger.error(
        { zapRunId: zapRun.id.toString(), stepId: stepId.toString(), errorCode: result.errorCode },
        '[ALERT] Step transitioned to ambiguous — run halted. Manual investigation required.',
      );
    } else {
      logger.warn({ zapRunId: zapRun.id.toString(), stepId: stepId.toString(), status: result.status, errorCode: result.errorCode }, 'step failed — run halted');
    }
    await markFailed(
      zapRun.id,
      result.errorCode ?? result.status,
      stepId,
    );
    return;
  }
}

