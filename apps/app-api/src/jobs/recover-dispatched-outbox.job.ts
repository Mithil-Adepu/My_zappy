import cron from 'node-cron';
import { prisma } from '@zapier-clone/db';
import * as Sentry from '@sentry/node';
import { logger } from '../lib/logger';

const STUCK_MINUTES = 15;

/**
 * Recovers outbox rows stuck at 'dispatched' for more than STUCK_MINUTES.
 *
 * When the relay process is killed after marking rows 'dispatched' but before
 * producing to Kafka, those rows are never retried (the poller only picks up
 * 'pending' rows). This job detects the gap and resets them to 'pending' so
 * the relay's next sweep picks them up.
 *
 * Runs every 10 minutes. Threshold of 15 minutes gives relay ample time to
 * produce normally without false positives.
 *
 * Note: This is a recovery mechanism, not a primary guarantee. The real fix
 * for relay crash is relay graceful shutdown (already implemented in main.ts).
 */
export function startRecoverDispatchedOutboxJob(): void {
  cron.schedule('*/10 * * * *', async () => {
    try {
      const threshold = new Date(Date.now() - STUCK_MINUTES * 60 * 1000);

      const result = await prisma.outbox.updateMany({
        where: {
          status: 'dispatched',
          createdAt: { lt: threshold },
        },
        data: { status: 'pending' },
      });

      if (result.count > 0) {
        const message = `[recovery] Reset ${result.count} stuck 'dispatched' outbox row(s) to 'pending' (stuck >${STUCK_MINUTES} min)`;
        logger.warn({ count: result.count }, message);
        if (process.env.SENTRY_DSN) {
          Sentry.captureMessage(message, 'warning');
        }
      }
    } catch (err) {
      logger.error({ err }, '[cron] recover-dispatched-outbox failed');
      Sentry.captureException(err);
    }
  });
}
