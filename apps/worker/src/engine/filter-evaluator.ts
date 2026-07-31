/**
 * Filter evaluator (design doc §12, rule 2)
 *
 * Evaluates a filter step's config against the current payload context.
 * Returns true (pass through) or false (halt run with status = 'filtered').
 *
 * Filter config shape:
 * {
 *   conditions: [
 *     { field: "payload.payment.entity.amount", operator: "gt", value: 1000 }
 *   ],
 *   logic: "AND" | "OR"  (default: "AND")
 * }
 */

import { resolvePath } from '../lib/resolve-path';

type Operator = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'exists';

interface FilterCondition {
  field: string;
  operator: Operator;
  value?: unknown;
}

interface FilterConfig {
  conditions: FilterCondition[];
  logic?: 'AND' | 'OR';
}

function evaluateCondition(
  condition: FilterCondition,
  context: Record<string, unknown>,
): boolean {
  const { value: actual } = resolvePath(context, condition.field);

  switch (condition.operator) {
    case 'eq':
      // Explicit String coercion: "100" == 100 is intentional for webhook payloads
      // where numeric IDs may arrive as strings. Using String() makes the intent clear.
      return String(actual) === String(condition.value);
    case 'neq':
      return String(actual) !== String(condition.value);
    case 'contains':
      return typeof actual === 'string' &&
        typeof condition.value === 'string' &&
        actual.includes(condition.value);
    case 'gt':
      return Number(actual) > Number(condition.value);
    case 'lt':
      return Number(actual) < Number(condition.value);
    case 'gte':
      return Number(actual) >= Number(condition.value);
    case 'lte':
      return Number(actual) <= Number(condition.value);
    case 'exists':
      return actual !== undefined && actual !== null;
    default:
      return false;
  }
}

/**
 * Evaluates all filter conditions in the step config.
 * Returns true if the run should continue, false if it should be filtered.
 */
export function evaluate(
  filterConfig: Record<string, unknown>,
  payloadContext: Record<string, unknown>,
): boolean {
  const config = filterConfig as unknown as FilterConfig;

  if (!config.conditions || config.conditions.length === 0) {
    // No conditions → pass
    return true;
  }

  const logic = config.logic ?? 'AND';
  const results = config.conditions.map((c) =>
    evaluateCondition(c, payloadContext),
  );

  return logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
}
