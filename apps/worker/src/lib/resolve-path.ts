/**
 * Shared dot-notation path resolver for the worker engine.
 *
 * Used by filter-evaluator.ts and template-substitution.ts to
 * traverse nested payload objects via "a.b.c" style paths.
 */

/**
 * Resolves a dot-notation path in a nested object, returning the value
 * and whether it was found (distinguished from found-but-undefined).
 *
 * e.g. resolvePath({ payload: { amount: 500 } }, "payload.amount")
 *      → { value: 500, found: true }
 */
export function resolvePath(
  obj: unknown,
  path: string,
): { value: unknown; found: boolean } {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { value: undefined, found: false };
    }
    current = (current as Record<string, unknown>)[part];
  }

  return { value: current, found: current !== undefined };
}
