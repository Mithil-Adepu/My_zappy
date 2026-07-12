/**
 * Unit tests for run-consumer.ts
 * Tests: idempotency (existing run reuse), run cap enforcement, inactive zap handling
 *
 * All external deps mocked — no Postgres/Kafka required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Prisma ───────────────────────────────────────────────────────────────
const mockQueryRaw = vi.fn();
const mockOutboxUpdateMany = vi.fn();
const mockZapFindUnique = vi.fn();
const mockZapRunUpdate = vi.fn();
const mockZapRunFindUnique = vi.fn();

vi.mock('@zapier-clone/db', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    outbox: { updateMany: (...args: unknown[]) => mockOutboxUpdateMany(...args) },
    zap: { findUnique: (...args: unknown[]) => mockZapFindUnique(...args) },
    zapRun: {
      findUnique: (...args: unknown[]) => mockZapRunFindUnique(...args),
      update: (...args: unknown[]) => mockZapRunUpdate(...args),
    },
  },
}));

// ─── Mock Kafka consumer (not tested here) ────────────────────────────────────
vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => ({
    consumer: vi.fn(() => ({
      connect: vi.fn(),
      subscribe: vi.fn(),
      run: vi.fn(),
      disconnect: vi.fn(),
      pause: vi.fn(),
    })),
  })),
}));

// ─── Mock rate limiter ────────────────────────────────────────────────────────
const mockUnderRunCap = vi.fn();
vi.mock('../../services/rate-limiter.service', () => ({
  underRunCap: (...args: unknown[]) => mockUnderRunCap(...args),
  checkAndConsume: vi.fn().mockResolvedValue(true),
  disconnectRedis: vi.fn(),
}));

// ─── Mock sequential executor ─────────────────────────────────────────────────
const mockResume = vi.fn();
vi.mock('../../engine/sequential-executor', () => ({
  resume: (...args: unknown[]) => mockResume(...args),
}));

vi.mock('../../config/env', () => ({
  env: {
    KAFKA_CLIENT_ID: 'test',
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_GROUP_ID_WORKER: 'test-group',
    KAFKA_TOPIC_ZAP_RUN_REQUESTED: 'zap.run.requested',
    WORKER_LEASE_TIMEOUT_MS: 120000,
    WORKER_RATE_LIMIT_PER_CONNECTION: 100,
    WORKER_RATE_LIMIT_WINDOW_SECONDS: 60,
  },
}));

import { onMessage } from '../run-consumer';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeEvent(overrides = {}) {
  return {
    webhookEventId: '42',
    zapId: '10',
    userId: '1',
    payload: { event: 'payment.captured', payload: { payment: { entity: { amount: 5000 } } } },
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStepSnapshot() {
  return JSON.stringify([{
    id: '100',
    position: 0,
    stepType: 'trigger',
    availableActionId: null,
    availableTriggerId: 'razorpay:payment-captured',
    connectionId: null,
    config: {},
  }]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('run-consumer — onMessage()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: fresh insert succeeds
    mockQueryRaw.mockResolvedValue([{ id: BigInt(99), step_snapshot: makeStepSnapshot() }]);
    mockOutboxUpdateMany.mockResolvedValue({});
    mockZapFindUnique.mockResolvedValue({ maxRunsPerHour: 100, isActive: true });
    mockUnderRunCap.mockResolvedValue(true);
    mockResume.mockResolvedValue(undefined);
  });

  it('inserts new run and calls resume()', async () => {
    await onMessage(makeEvent());
    expect(mockResume).toHaveBeenCalledOnce();
    expect(mockOutboxUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'consumed' }) }),
    );
  });

  it('reuses existing run on Kafka redeliver (idempotency)', async () => {
    // Simulate ON CONFLICT DO NOTHING → empty rows
    mockQueryRaw.mockResolvedValue([]);
    mockZapRunFindUnique.mockResolvedValue({
      id: BigInt(99),
      stepSnapshot: makeStepSnapshot(),
      status: 'in_progress',
    });

    await onMessage(makeEvent());
    expect(mockResume).toHaveBeenCalledOnce();
  });

  it('skips resume() when existing run is already terminal', async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockZapRunFindUnique.mockResolvedValue({
      id: BigInt(99),
      stepSnapshot: makeStepSnapshot(),
      status: 'completed',
    });

    await onMessage(makeEvent());
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('skips run when zap is inactive', async () => {
    mockZapFindUnique.mockResolvedValue({ maxRunsPerHour: 100, isActive: false });

    await onMessage(makeEvent());
    expect(mockResume).not.toHaveBeenCalled();
    expect(mockUnderRunCap).not.toHaveBeenCalled();
  });

  it('marks run failed and skips resume() when hourly cap is exceeded', async () => {
    mockUnderRunCap.mockResolvedValue(false);

    await onMessage(makeEvent());
    expect(mockResume).not.toHaveBeenCalled();
    expect(mockZapRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('enforces run cap with correct zap maxRunsPerHour', async () => {
    mockZapFindUnique.mockResolvedValue({ maxRunsPerHour: 5, isActive: true });
    mockUnderRunCap.mockResolvedValue(true);

    await onMessage(makeEvent());
    expect(mockUnderRunCap).toHaveBeenCalledWith(BigInt(10), 5);
  });
});
