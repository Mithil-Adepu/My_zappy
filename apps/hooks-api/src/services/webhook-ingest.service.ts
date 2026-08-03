import { prisma } from '@zapier-clone/db';
import { Prisma } from '@prisma/client';
import { verifyWebhook } from './hmac-verify.service';
import { logger } from '../lib/logger';

export type IngestStatus = 'ingested' | 'duplicate' | 'unauthorized' | 'not_found' | 'skipped';

interface IngestResult {
  status: IngestStatus;
}

/**
 * Routing table for tier-1 GitHub triggers.
 *
 * Maps each available_trigger_id to:
 *   - githubEvent: the expected value of the X-GitHub-Event header
 *   - actionFilter: optional — payload.action must equal this value
 *   - refTypeFilter: optional — payload.ref_type must equal this value (for 'create' events)
 *
 * If a trigger ID is NOT in this table and a GitHub event header IS present,
 * it must be webhooks:catch_hook (tier-2) — pass through unconditionally.
 */
const GITHUB_TRIGGER_ROUTING: Record<
  string,
  { githubEvent: string; actionFilter?: string; refTypeFilter?: string }
> = {
  'github:push': { githubEvent: 'push' },
  'github:pull_request_opened': { githubEvent: 'pull_request', actionFilter: 'opened' },
  'github:issue_opened': { githubEvent: 'issues', actionFilter: 'opened' },
  'github:branch_created': { githubEvent: 'create', refTypeFilter: 'branch' },
  'github:release_published': { githubEvent: 'release', actionFilter: 'published' },
};

/**
 * Returns true if this GitHub delivery should be ingested for the given trigger.
 * Returns false if the event type or action doesn't match — caller returns 200 silently.
 */
/** Exported for unit testing only. Use ingestWebhook for production code. */
export function matchesGitHubTrigger(
  availableTriggerId: string | null,
  githubEventType: string,
  payload: Record<string, unknown>,
): boolean {
  // Tier-2 catch-hook or non-GitHub trigger: always accept
  if (!availableTriggerId || !(availableTriggerId in GITHUB_TRIGGER_ROUTING)) {
    return true;
  }

  const rule = GITHUB_TRIGGER_ROUTING[availableTriggerId];

  // Check X-GitHub-Event header matches expected event type
  if (githubEventType !== rule.githubEvent) return false;

  // Check action filter (e.g. only "opened" pull_requests)
  if (rule.actionFilter && payload['action'] !== rule.actionFilter) return false;

  // Check ref_type filter (e.g. only "branch" creates, not tags)
  if (rule.refTypeFilter && payload['ref_type'] !== rule.refTypeFilter) return false;

  return true;
}

/**
 * Core ingest logic — called by the webhook controller.
 *
 * Flow (from design doc §6):
 *  1. Look up the zap + trigger step to get the webhook_secret
 *  2. Verify HMAC — 401 + no DB write on failure
 *  3. GitHub event routing — if the X-GitHub-Event header doesn't match the
 *     step's configured trigger, return 'skipped' (200 to caller, no outbox write)
 *  4. Single transaction:
 *     a. INSERT webhook_events ON CONFLICT DO NOTHING
 *     b. If new row: INSERT outbox row
 *  5. Return result (controller always responds 200)
 */
export async function ingestWebhook(
  zapId: string,
  stepId: string,
  rawBody: Buffer,
  signature: string,
  eventId: string,
  githubEventType: string = '',
): Promise<IngestResult> {
  // 1. Look up the trigger step to get the webhook secret
  const step = await prisma.zapStep.findFirst({
    where: {
      id: BigInt(stepId),
      zapId: BigInt(zapId),
      stepType: 'trigger',
    },
    include: {
      zap: { select: { isActive: true, userId: true } },
    },
  });

  if (!step || !step.webhookSecret) {
    logger.warn({ zapId, stepId }, 'webhook not found or missing secret');
    return { status: 'not_found' };
  }

  // §6 — Inactive zaps silently drop webhooks (always 200 to caller)
  if (!step.zap.isActive) {
    logger.info({ zapId, stepId, eventId }, 'webhook received for inactive zap — silently dropping');
    return { status: 'not_found' };
  }

  // 2. HMAC verification — reject with no DB write on failure
  const valid = verifyWebhook(rawBody, signature, step.webhookSecret);
  if (!valid) {
    logger.warn({ zapId, stepId, eventId }, 'HMAC verification failed');
    return { status: 'unauthorized' };
  }

  // Parse body (safe now — verification passed)
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    payload = { raw: rawBody.toString('utf8') };
  }

  // 3. GitHub event routing — check if this delivery matches the step's trigger
  if (githubEventType && !matchesGitHubTrigger(step.availableTriggerId, githubEventType, payload)) {
    logger.info(
      { zapId, stepId, eventId, githubEventType, availableTriggerId: step.availableTriggerId },
      'GitHub event type or action does not match trigger config — skipping',
    );
    return { status: 'skipped' };
  }

  // 4. Atomic transaction: webhook_events + outbox
  const result = await prisma.$transaction(async (tx) => {
    // INSERT ... ON CONFLICT (event_id, zap_id) DO NOTHING RETURNING id
    const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO webhook_events (event_id, zap_id, payload)
      VALUES (${eventId}, ${BigInt(zapId)}, ${payload}::jsonb)
      ON CONFLICT (event_id, zap_id) DO NOTHING
      RETURNING id
    `;

    if (rows.length === 0) {
      logger.info({ zapId, stepId, eventId }, 'duplicate webhook event — skipping outbox write');
      return 'duplicate';
    }

    const webhookEventId = rows[0].id;

    await tx.outbox.create({
      data: {
        webhookEventId,
        eventId,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    logger.info({ zapId, stepId, eventId, webhookEventId: webhookEventId.toString() }, 'webhook ingested and outbox row created');
    return 'ingested';
  });

  return { status: result as 'ingested' | 'duplicate' };
}
