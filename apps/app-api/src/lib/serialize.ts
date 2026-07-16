/**
 * Shared BigInt serialization utility (TASK-5.1).
 *
 * Prisma returns BigInt for all ID columns. JSON.stringify throws on BigInt,
 * so we must replace with strings before sending over the wire.
 *
 * Centralised here to avoid copy-paste across controllers.
 */
export function serializeBigInt(obj: unknown): unknown {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}
