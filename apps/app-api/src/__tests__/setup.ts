/**
 * Vitest setup file — sets required env vars before any module is loaded.
 * This prevents env.ts from calling process.exit(1) during tests.
 */
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_SECRET = 'test-secret-at-least-16-chars!!';
process.env.JWT_EXPIRES_IN = '7d';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.APP_API_PORT = '3001';
process.env.WEB_APP_URL = 'http://localhost:3000';
process.env.NODE_ENV = 'test';
