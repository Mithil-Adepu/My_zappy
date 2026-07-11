import cron from 'node-cron';
import { prisma } from '@zapier-clone/db';
import { refreshAccessToken } from '../services/oauth.service';

/**
 * Refreshes OAuth connections expiring within the next 30 minutes.
 * Runs every 15 minutes.
 * Lazy refresh (on 401 during execution) is the primary guarantee;
 * this is the backup sweep for idle connections.
 */
export function startRefreshExpiringTokensJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    console.log('[cron] Checking for expiring tokens...');
    try {
      const threshold = new Date(Date.now() + 30 * 60 * 1000); // 30 min from now
      const expiring = await prisma.connection.findMany({
        where: {
          expiresAt: { lte: threshold, gt: new Date() },
          accessToken: { not: null },
        },
        select: { id: true, connectorId: true },
      });

      for (const conn of expiring) {
        try {
          await refreshAccessToken(conn.id);
          console.log(`[cron] Refreshed token for connection ${conn.id}`);
        } catch (err) {
          console.error(
            `[cron] Failed to refresh token for connection ${conn.id}:`,
            err,
          );
        }
      }

      console.log(`[cron] Token refresh sweep done. ${expiring.length} refreshed.`);
    } catch (err) {
      console.error('[cron] refresh-expiring-tokens failed:', err);
    }
  });
}
