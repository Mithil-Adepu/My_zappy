import { describe, it, expect } from 'vitest';
import { matchesGitHubTrigger } from '../webhook-ingest.service';

describe('matchesGitHubTrigger', () => {
  // ─── Tier-2 / non-GitHub: always pass through ─────────────────────────────

  it('returns true for webhooks:catch_hook regardless of event type', () => {
    expect(matchesGitHubTrigger('webhooks:catch_hook', 'push', {})).toBe(true);
    expect(matchesGitHubTrigger('webhooks:catch_hook', 'issues', { action: 'closed' })).toBe(true);
    expect(matchesGitHubTrigger('webhooks:catch_hook', 'star', {})).toBe(true);
  });

  it('returns true for unknown trigger IDs (non-GitHub connectors)', () => {
    expect(matchesGitHubTrigger('razorpay:payment_captured', 'push', {})).toBe(true);
    expect(matchesGitHubTrigger(null, 'push', {})).toBe(true);
  });

  // ─── github:push ──────────────────────────────────────────────────────────

  it('matches github:push when X-GitHub-Event is push', () => {
    expect(matchesGitHubTrigger('github:push', 'push', {})).toBe(true);
  });

  it('rejects github:push for non-push events', () => {
    expect(matchesGitHubTrigger('github:push', 'pull_request', { action: 'opened' })).toBe(false);
    expect(matchesGitHubTrigger('github:push', 'issues', { action: 'opened' })).toBe(false);
    expect(matchesGitHubTrigger('github:push', 'release', { action: 'published' })).toBe(false);
  });

  // ─── github:pull_request_opened ───────────────────────────────────────────

  it('matches github:pull_request_opened for pull_request + action:opened', () => {
    expect(matchesGitHubTrigger('github:pull_request_opened', 'pull_request', { action: 'opened' })).toBe(true);
  });

  it('rejects github:pull_request_opened for other pull_request actions', () => {
    expect(matchesGitHubTrigger('github:pull_request_opened', 'pull_request', { action: 'closed' })).toBe(false);
    expect(matchesGitHubTrigger('github:pull_request_opened', 'pull_request', { action: 'synchronize' })).toBe(false);
    expect(matchesGitHubTrigger('github:pull_request_opened', 'pull_request', {})).toBe(false);
  });

  it('rejects github:pull_request_opened for wrong event type', () => {
    expect(matchesGitHubTrigger('github:pull_request_opened', 'push', {})).toBe(false);
  });

  // ─── github:issue_opened ──────────────────────────────────────────────────

  it('matches github:issue_opened for issues + action:opened', () => {
    expect(matchesGitHubTrigger('github:issue_opened', 'issues', { action: 'opened' })).toBe(true);
  });

  it('rejects github:issue_opened for issues + closed', () => {
    expect(matchesGitHubTrigger('github:issue_opened', 'issues', { action: 'closed' })).toBe(false);
    expect(matchesGitHubTrigger('github:issue_opened', 'issues', { action: 'labeled' })).toBe(false);
  });

  // ─── github:branch_created ────────────────────────────────────────────────

  it('matches github:branch_created for create + ref_type:branch', () => {
    expect(matchesGitHubTrigger('github:branch_created', 'create', { ref_type: 'branch' })).toBe(true);
  });

  it('rejects github:branch_created for create + ref_type:tag (tag creation)', () => {
    expect(matchesGitHubTrigger('github:branch_created', 'create', { ref_type: 'tag' })).toBe(false);
    expect(matchesGitHubTrigger('github:branch_created', 'create', {})).toBe(false);
  });

  // ─── github:release_published ─────────────────────────────────────────────

  it('matches github:release_published for release + action:published', () => {
    expect(matchesGitHubTrigger('github:release_published', 'release', { action: 'published' })).toBe(true);
  });

  it('rejects github:release_published for release + action:created (draft)', () => {
    expect(matchesGitHubTrigger('github:release_published', 'release', { action: 'created' })).toBe(false);
    expect(matchesGitHubTrigger('github:release_published', 'release', { action: 'edited' })).toBe(false);
  });
});
