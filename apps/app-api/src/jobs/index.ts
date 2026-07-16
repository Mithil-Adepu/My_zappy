import { startRefreshExpiringTokensJob } from './refresh-expiring-tokens.job';
import { startOutboxCleanupJob } from './outbox-cleanup.job';
import { startStuckOutboxAlertJob } from './stuck-outbox-alert.job';
import { logger } from '../lib/logger';

export function startCronJobs(): void {
  startRefreshExpiringTokensJob();
  startOutboxCleanupJob();
  startStuckOutboxAlertJob();
  logger.info('✅  Cron jobs started');
}
