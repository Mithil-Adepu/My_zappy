import cron from 'node-cron';
import { prisma } from '@zapier-clone/db';

/**
 * Deletes consumed outbox rows older than 7 days.
 * Runs daily at midnight.
 * Does NOT touch 'pending', 'dispatched', or 'dead' rows — those are signals.
 */
export function startOutboxCleanupJob(): void {
  cron.schedule('0 0 * * *', async () => {
    console.log('[cron] Running outbox cleanup...');
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const result = await prisma.outbox.deleteMany({
        where: {
          status: 'consumed',
          createdAt: { lt: cutoff },
        },
      });
      console.log(`[cron] Outbox cleanup: deleted ${result.count} consumed rows`);
    } catch (err) {
      console.error('[cron] outbox-cleanup failed:', err);
    }
  });
}
