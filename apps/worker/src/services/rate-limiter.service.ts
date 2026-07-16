import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../lib/logger';

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL);
    redis.on('error', (err) => logger.error({ err }, '[worker] Redis error'));
  }
  return redis;
}

/**
 * Atomic increment with expiry using a Lua script.
 * Equivalent to: INCR key + (if new key) EXPIRE key window
 * but in a single atomic operation — safe against crash between INCR and EXPIRE.
 */
const ATOMIC_INCR_EXPIRE = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

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
  const count = await client.eval(ATOMIC_INCR_EXPIRE, 1, key, String(windowSeconds)) as number;
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
  const count = await client.eval(ATOMIC_INCR_EXPIRE, 1, key, '3600') as number;
  return count <= cap;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

