import { createError } from '../middleware/error-handler.middleware';

interface StepInput {
  stepType: string;
  position: number;
  availableTriggerId?: string | null;
  availableActionId?: string | null;
  connectionId?: bigint | null;
  config?: Record<string, unknown>;
}

/**
 * Validates the full set of zap steps before creation or update.
 * Rules from the design doc §12:
 *  1. Exactly one step with stepType = 'trigger' at position 0
 *  2. Positions are contiguous starting at 0 (0, 1, 2, 3... — no gaps)
 *  3. No duplicate positions
 *  4. Trigger step must have availableTriggerId set, not availableActionId
 *  5. Action/filter steps must NOT have availableTriggerId set
 */
export function validateZapSteps(steps: StepInput[]): void {
  if (!steps || steps.length === 0) {
    throw createError('A zap must have at least one step (the trigger)', 400);
  }

  // Check for duplicate positions
  const positions = steps.map((s) => s.position);
  const uniquePositions = new Set(positions);
  if (uniquePositions.size !== positions.length) {
    throw createError('Duplicate step positions are not allowed', 400);
  }

  // Check contiguity
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i) {
      throw createError(
        `Step positions must be contiguous starting at 0. Found gap at position ${i}`,
        400,
      );
    }
  }

  // Exactly one trigger at position 0
  const triggers = steps.filter((s) => s.stepType === 'trigger');
  if (triggers.length !== 1) {
    throw createError('A zap must have exactly one trigger step', 400);
  }
  if (triggers[0].position !== 0) {
    throw createError('The trigger step must be at position 0', 400);
  }

  // Validate step type consistency
  for (const step of steps) {
    if (step.stepType === 'trigger' && !step.availableTriggerId) {
      throw createError('Trigger step must specify availableTriggerId', 400);
    }
    if (step.stepType === 'trigger' && step.availableActionId) {
      throw createError(
        'Trigger step must not specify availableActionId',
        400,
      );
    }
    if (
      (step.stepType === 'action' || step.stepType === 'filter') &&
      step.availableTriggerId
    ) {
      throw createError(
        'Action/filter steps must not specify availableTriggerId',
        400,
      );
    }
    if (!['trigger', 'action', 'filter'].includes(step.stepType)) {
      throw createError(
        `Invalid stepType: ${step.stepType}. Must be trigger, action, or filter`,
        400,
      );
    }
  }
}
