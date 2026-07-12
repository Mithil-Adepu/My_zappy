import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('zapier-relay'),
  KAFKA_TOPIC_ZAP_RUN_REQUESTED: z.string().default('zap.run.requested'),
  RELAY_POLL_INTERVAL_MS: z.string().default('2000').transform(Number),
  RELAY_BATCH_SIZE: z.string().default('50').transform(Number),
  RELAY_HEALTH_PORT: z.string().default('3003').transform(Number),
  SENTRY_DSN: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌  relay: Invalid environment variables');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
