import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('zapier-worker'),
  KAFKA_GROUP_ID_WORKER: z.string().default('zapier-worker'),
  KAFKA_TOPIC_ZAP_RUN_REQUESTED: z.string().default('zap.run.requested'),
  WORKER_LEASE_TIMEOUT_MS: z.string().default('120000').transform(Number),
  WORKER_RATE_LIMIT_PER_CONNECTION: z.string().default('100').transform(Number),
  WORKER_RATE_LIMIT_WINDOW_SECONDS: z.string().default('60').transform(Number),
  WORKER_HEALTH_PORT: z.string().default('3004').transform(Number),
  ENCRYPTION_KEY: z.string().length(64),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌  worker: Invalid environment variables');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
