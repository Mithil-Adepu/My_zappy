import Redis from 'ioredis';
import { env } from '../config/env';

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL);
    redis.on('error', (err) => console.error('[worker] Redis error:', err));
  }
  return redis;
}

/**
 * Token bucket rate limiter — §11
 * Returns true if under limit (and consumes one token).
 * Returns false if rate limit exceeded — caller must requeue, not fail.
 */
export async function checkAndConsume(
  connectionId: bigint,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = `ratelimit:${connectionId}`;
  const client = getRedis();
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, windowSeconds);
  }
  return count <= limit;
}

/**
 * Self-protection cap — max runs per hour per zap.
 * Returns true if under cap. Caller skips execution if false.
 */
export async function underRunCap(zapId: bigint, cap: number): Promise<boolean> {
  const hourBucket = Math.floor(Date.now() / 3600000);
  const key = `runcap:${zapId}:${hourBucket}`;
  const client = getRedis();
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, 3600);
  }
  return count <= cap;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
