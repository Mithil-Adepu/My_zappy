/**
 * Template substitution engine (design doc §9.4)
 *
 * Resolves {{field.path}} tokens in step config values using the accumulated
 * payload context from previous steps.
 *
 * Unresolved fields → null (NOT a string placeholder like "[missing]")
 * This is critical: null passes type-relaxed AJV validation without blocking
 * the entire action when one optional field is missing.
 */

interface SubstituteResult {
  mappedPayload: Record<string, unknown>;
  unresolvedFields: string[];
}

const TEMPLATE_REGEX = /\{\{([^}]+)\}\}/g;

/**
 * Resolves a dot-notation path in a nested object.
 * e.g. "payload.payment.entity.amount" in { payload: { payment: { entity: { amount: 500 } } } }
 */
function resolvePath(obj: unknown, path: string): { value: unknown; found: boolean } {
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

/**
 * Substitutes a single template string value.
 * If the entire value is a single {{token}}, returns the resolved value directly
 * (preserving its original type — number, boolean, etc.)
 * If the value mixes text + tokens, string-interpolates everything.
 */
function substituteValue(
  template: unknown,
  context: Record<string, unknown>,
): { value: unknown; resolved: boolean } {
  if (typeof template !== 'string') {
    // Non-string values (numbers, booleans, objects) have no templates — pass through
    return { value: template, resolved: true };
  }

  // Check if the entire value is a single {{token}}
  const singleTokenMatch = template.match(/^\{\{([^}]+)\}\}$/);
  if (singleTokenMatch) {
    const path = singleTokenMatch[1].trim();
    const { value, found } = resolvePath(context, path);
    return { value: found ? value : null, resolved: found };
  }

  // Mixed string — interpolate all tokens
  let allResolved = true;
  const result = template.replace(TEMPLATE_REGEX, (_match, path: string) => {
    const { value, found } = resolvePath(context, path.trim());
    if (!found) {
      allResolved = false;
      return '';
    }
    return String(value);
  });

  return { value: result, resolved: allResolved };
}

/**
 * Applies template substitution to a full config object.
 * Returns the mapped payload and a list of fields that couldn't be resolved.
 */
export function apply(
  configTemplate: Record<string, unknown>,
  payloadContext: Record<string, unknown>,
): SubstituteResult {
  const mappedPayload: Record<string, unknown> = {};
  const unresolvedFields: string[] = [];

  for (const [key, template] of Object.entries(configTemplate)) {
    const { value, resolved } = substituteValue(template, payloadContext);
    mappedPayload[key] = resolved ? value : null;
    if (!resolved) unresolvedFields.push(key);
  }

  return { mappedPayload, unresolvedFields };
}
