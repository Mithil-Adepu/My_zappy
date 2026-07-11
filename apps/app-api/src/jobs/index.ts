import { startRefreshExpiringTokensJob } from './refresh-expiring-tokens.job';
import { startOutboxCleanupJob } from './outbox-cleanup.job';
import { startStuckOutboxAlertJob } from './stuck-outbox-alert.job';

export function startCronJobs(): void {
  startRefreshExpiringTokensJob();
  startOutboxCleanupJob();
  startStuckOutboxAlertJob();
  console.log('✅  Cron jobs started');
}
