// Helpers needed by step-runner to avoid circular imports
import { checkAndConsume as _checkAndConsume } from '../services/rate-limiter.service';
import { releaseWithDelay as _releaseWithDelay } from '../services/claim.service';

export async function checkAndConsume(
  connectionId: bigint,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  return _checkAndConsume(connectionId, limit, windowSeconds);
}

export async function releaseWithDelay(claimedRowId: bigint): Promise<void> {
  return _releaseWithDelay(claimedRowId);
}
