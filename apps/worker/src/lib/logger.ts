import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Shared structured logger for worker.
 * In dev: pretty-printed to stdout.
 * In production: JSON Lines to stdout (consumed by log aggregator).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }
    : {}),
  base: { service: 'worker' },
});
