/**
 * Shared BigInt serialization utility (TASK-5.1).
 *
 * Prisma returns BigInt for all ID columns. JSON.stringify throws on BigInt,
 * so we must replace with strings before sending over the wire.
 *
 * Accepts any value (no cast required at call site) and returns the
 * JSON-round-tripped value with all BigInts converted to strings.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeBigInt(obj: unknown): any {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}
