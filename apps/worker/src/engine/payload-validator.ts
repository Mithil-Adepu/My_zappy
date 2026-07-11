import Ajv, { JSONSchemaType, AnySchema } from 'ajv';

const ajv = new Ajv({ allErrors: true, coerceTypes: true });

export interface ValidationResult {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  unresolvedFields: string[];
}

/**
 * Builds a relaxed schema where unresolved fields are allowed to be null,
 * regardless of their declared type.
 * This prevents "one missing template value blocks the whole action" — design doc §9.4
 */
function relaxRequiredAndTypesFor(
  inputSchema: AnySchema,
  unresolvedFields: string[],
): AnySchema {
  if (!inputSchema || typeof inputSchema !== 'object') return inputSchema;

  const schema = JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown>;

  if (unresolvedFields.length === 0) return schema;

  // Remove unresolved fields from required array
  if (Array.isArray(schema['required'])) {
    schema['required'] = (schema['required'] as string[]).filter(
      (field) => !unresolvedFields.includes(field),
    );
  }

  // For each unresolved field, allow null type
  const properties = schema['properties'] as Record<string, unknown> | undefined;
  if (properties) {
    for (const field of unresolvedFields) {
      if (properties[field]) {
        const fieldSchema = properties[field] as Record<string, unknown>;
        const originalType = fieldSchema['type'];
        if (originalType) {
          fieldSchema['type'] = Array.isArray(originalType)
            ? [...(originalType as string[]), 'null']
            : [originalType as string, 'null'];
        }
        fieldSchema['nullable'] = true;
      }
    }
  }

  return schema;
}

/**
 * Validates the mapped payload against the action's input schema.
 * Unresolved template fields are relaxed — they become nullable.
 */
export function validateMappedPayload(
  mappedPayload: Record<string, unknown>,
  inputSchema: Record<string, unknown> | null,
  unresolvedFields: string[],
): ValidationResult {
  if (!inputSchema) {
    // No schema defined — pass everything through
    return { success: true, unresolvedFields };
  }

  const relaxedSchema = relaxRequiredAndTypesFor(inputSchema as AnySchema, unresolvedFields);
  const validate = ajv.compile(relaxedSchema);

  if (!validate(mappedPayload)) {
    const errorMessage = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');

    return {
      success: false,
      errorCode: 'VALIDATION_FAILED',
      errorMessage,
      unresolvedFields,
    };
  }

  // Still surface unresolvedFields in output for visibility — not silently dropped
  return { success: true, unresolvedFields };
}
