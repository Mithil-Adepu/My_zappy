/**
 * Unit tests for sequential-executor.ts
 * All branches: completed, filtered (pass/fail), failed, ambiguous, processing, context enrichment.
 *
 * Mocks all external deps — no Postgres/Kafka/Redis required.
 * Note: Vitest isolates modules per worker — keep this file lightweight to avoid OOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── All mocks must come before any imports ───────────────────────────────────

vi.mock('@zapier-clone/db', () => ({
  prisma: {
    zapRunStep: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const mockClaim = vi.fn();
const mockMarkStepCompleted = vi.fn();
const mockRecordStepResult = vi.fn();

vi.mock('../../services/claim.service', () => ({
  claim: (...args: unknown[]) => mockClaim(...args),
  markStepCompleted: (...args: unknown[]) => mockMarkStepCompleted(...args),
  recordStepResult: (...args: unknown[]) => mockRecordStepResult(...args),
}));

const mockMarkCompleted = vi.fn();
const mockMarkFiltered = vi.fn();
const mockMarkFailed = vi.fn();

vi.mock('../../services/run-state.service', () => ({
  markCompleted: (...args: unknown[]) => mockMarkCompleted(...args),
  markFiltered: (...args: unknown[]) => mockMarkFiltered(...args),
  markFailed: (...args: unknown[]) => mockMarkFailed(...args),
}));

const mockEvaluateFilter = vi.fn();

vi.mock('../filter-evaluator', () => ({
  evaluate: (...args: unknown[]) => mockEvaluateFilter(...args),
}));

const mockRunStep = vi.fn();

vi.mock('../step-runner', () => ({
  runStep: (...args: unknown[]) => mockRunStep(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub out Kafka/Redis imports that step-runner and consumer might drag in
vi.mock('kafkajs', () => ({ Kafka: vi.fn() }));
vi.mock('ioredis', () => ({ default: vi.fn() }));

import { resume } from '../sequential-executor';
import { prisma } from '@zapier-clone/db';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRun(overrides: Record<string, unknown> = {}) {
  return { id: BigInt(1), zapId: BigInt(10), stepSnapshot: [], ...overrides };
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: BigInt(100),
    position: 0,
    stepType: 'action' as const,
    availableActionId: 'slack:send-message',
    availableTriggerId: null,
    connectionId: BigInt(5),
    config: { channel: '#general', text: 'hello' },
    availableAction: { inputSchema: null },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sequential-executor — resume()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.zapRunStep.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('marks run completed when snapshot is empty', async () => {
    await resume(makeRun(), {});
    expect(mockMarkCompleted).toHaveBeenCalledWith(BigInt(1));
  });

  it('marks run completed when all snapshot steps are already done in DB', async () => {
    const step = makeSnapshot({ position: 0 });
    (prisma.zapRunStep.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { zapStep: { position: 0 } },
    ]);
    await resume(makeRun({ stepSnapshot: [step] }), {});
    expect(mockMarkCompleted).toHaveBeenCalledWith(BigInt(1));
  });

  it('does not execute when claim() returns null (step owned elsewhere)', async () => {
    mockClaim.mockResolvedValue(null);
    await resume(makeRun({ stepSnapshot: [makeSnapshot()] }), {});
    expect(mockRunStep).not.toHaveBeenCalled();
  });

  it('halts run as filtered when filter condition fails', async () => {
    const filterStep = makeSnapshot({ stepType: 'filter', availableActionId: null, connectionId: null });
    mockClaim.mockResolvedValue({ id: BigInt(99), idempotencyKey: 'k' });
    mockEvaluateFilter.mockReturnValue(false);
    await resume(makeRun({ stepSnapshot: [filterStep] }), {});
    expect(mockMarkStepCompleted).toHaveBeenCalledWith(BigInt(99), { passed: false });
    expect(mockMarkFiltered).toHaveBeenCalledWith(BigInt(1));
  });

  it('continues after filter passes (run completes with no next step)', async () => {
    const filterStep = makeSnapshot({ stepType: 'filter', availableActionId: null, connectionId: null });
    mockClaim.mockResolvedValue({ id: BigInt(99), idempotencyKey: 'k' });
    mockEvaluateFilter.mockReturnValue(true);
    await resume(makeRun({ stepSnapshot: [filterStep] }), {});
    expect(mockMarkStepCompleted).toHaveBeenCalledWith(BigInt(99), { passed: true });
    expect(mockMarkCompleted).toHaveBeenCalledWith(BigInt(1));
  });

  it('marks run failed when action step returns failed', async () => {
    mockClaim.mockResolvedValue({ id: BigInt(99), idempotencyKey: 'k' });
    mockRunStep.mockResolvedValue({ status: 'failed', errorCode: 'SLACK_API_ERROR', errorMessage: 'channel_not_found' });
    await resume(makeRun({ stepSnapshot: [makeSnapshot()] }), {});
    expect(mockRecordStepResult).toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith(BigInt(1), 'SLACK_API_ERROR', BigInt(100));
  });

  it('marks run failed with AMBIGUOUS_TIMEOUT when step is ambiguous', async () => {
    mockClaim.mockResolvedValue({ id: BigInt(99), idempotencyKey: 'k' });
    mockRunStep.mockResolvedValue({ status: 'ambiguous', errorCode: 'AMBIGUOUS_TIMEOUT' });
    await resume(makeRun({ stepSnapshot: [makeSnapshot()] }), {});
    expect(mockMarkFailed).toHaveBeenCalledWith(BigInt(1), 'AMBIGUOUS_TIMEOUT', BigInt(100));
  });

  it('does not advance run when step is rate-limited (processing)', async () => {
    mockClaim.mockResolvedValue({ id: BigInt(99), idempotencyKey: 'k' });
    mockRunStep.mockResolvedValue({ status: 'processing' });
    await resume(makeRun({ stepSnapshot: [makeSnapshot()] }), {});
    expect(mockRecordStepResult).toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('marks run completed when action succeeds and no next step', async () => {
    mockClaim.mockResolvedValue({ id: BigInt(99), idempotencyKey: 'k' });
    mockRunStep.mockResolvedValue({ status: 'completed', output: { ts: '12345' } });
    await resume(makeRun({ stepSnapshot: [makeSnapshot()] }), {});
    expect(mockMarkCompleted).toHaveBeenCalledWith(BigInt(1));
  });
});
