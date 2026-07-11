import { prisma } from '@zapier-clone/db';
import { createError } from '../middleware/error-handler.middleware';

/**
 * Asserts that a connection belongs to the given user.
 * This is the real security boundary — not enforceable via FK because it's a
 * cross-row check (connection.userId == zap.userId).
 * Must be called on every write that associates a connection with a zap step.
 */
export async function assertConnectionOwnership(
  connectionId: bigint,
  userId: bigint,
): Promise<void> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { userId: true },
  });

  if (!connection) {
    throw createError('Connection not found', 404);
  }

  if (connection.userId !== userId) {
    throw createError(
      'You do not have access to this connection',
      403,
    );
  }
}
