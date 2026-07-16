import cron from 'node-cron';
import { prisma } from '@zapier-clone/db';
import { refreshAccessToken } from '../services/oauth.service';
import { logger } from '../lib/logger';

/**
 * Refreshes OAuth connections expiring within the next 30 minutes.
 * Runs every 15 minutes.
 * Lazy refresh (on 401 during execution) is the primary guarantee;
 * this is the backup sweep for idle connections.
 */
export function startRefreshExpiringTokensJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    logger.info('[cron] Checking for expiring tokens...');
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
          logger.info({ connectionId: conn.id.toString(), connectorId: conn.connectorId }, '[cron] Refreshed token');
        } catch (err) {
          logger.error({ err, connectionId: conn.id.toString() }, '[cron] Failed to refresh token');
        }
      }

      logger.info({ count: expiring.length }, '[cron] Token refresh sweep done');
    } catch (err) {
      logger.error({ err }, '[cron] refresh-expiring-tokens failed');
    }
  });
}

