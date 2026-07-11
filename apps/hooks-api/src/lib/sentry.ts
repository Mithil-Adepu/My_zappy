import * as Sentry from '@sentry/node';
import { env } from '../config/env';

/**
 * Initialise Sentry for hooks-api.
 * Must be called BEFORE any other imports in the entry point.
 * No-ops gracefully if SENTRY_DSN is not set.
 */
export function initSentry(): void {
  if (!process.env.SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 0,
    integrations: [Sentry.httpIntegration()],
  });
}

export { Sentry };
