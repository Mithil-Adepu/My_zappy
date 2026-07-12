import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  // Redis
  REDIS_URL: z.string().url(),
  // Auth
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // Encryption (AES-GCM key as 64-char hex = 32 bytes)
  ENCRYPTION_KEY: z.string().length(64),
  // Server
  APP_API_PORT: z.string().default('3001').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // OAuth — Slack
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().url().optional(),
  // Sentry
  SENTRY_DSN: z.string().optional(),
  // Web app origin (for OAuth redirect and CORS)
  WEB_APP_URL: z.string().url().default('http://localhost:3000'),
});

// Throws on startup if any required env vars are missing/invalid
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌  Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
