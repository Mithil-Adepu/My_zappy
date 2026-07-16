import cron from 'node-cron';
import { prisma } from '@zapier-clone/db';
import * as Sentry from '@sentry/node';
import { logger } from '../lib/logger';

const STUCK_THRESHOLD_MINUTES = 30;

/**
 * Alerts on outbox rows stuck at 'dispatched' for over 30 minutes.
 * These are real failure signals — they indicate the worker successfully
 * received the Kafka message but never marked the outbox row as consumed.
 * Runs every 5 minutes.
 *
 * §7.2.3: Sends Sentry alert when SENTRY_DSN is configured.
 */
export function startStuckOutboxAlertJob(): void {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const threshold = new Date(
        Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
      );
      const stuck = await prisma.outbox.findMany({
        where: {
          status: 'dispatched',
          createdAt: { lt: threshold },
        },
        select: { id: true, eventId: true, createdAt: true, attempts: true },
      });

      if (stuck.length > 0) {
        const message = `[ALERT] ${stuck.length} outbox row(s) stuck at 'dispatched' for >${STUCK_THRESHOLD_MINUTES}min. Manual intervention required.`;
        const stuckDetails = stuck.map((r) => ({
          id: r.id.toString(),
          eventId: r.eventId,
          attempts: r.attempts,
        }));
        logger.error({ stuckDetails }, message);

        // §7.2.3 — Sentry alert for stuck outbox rows
        if (process.env.SENTRY_DSN) {
          Sentry.captureMessage(message, 'error');
          Sentry.captureMessage(
            `Stuck outbox details: ${JSON.stringify(stuckDetails)}`,
            'warning',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, '[cron] stuck-outbox-alert failed');
      Sentry.captureException(err);
    }
  });
}
