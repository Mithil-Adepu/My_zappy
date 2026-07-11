/**
 * Integration test: claim.service with real Postgres.
 *
 * These tests require Docker to be available (Testcontainers spins up Postgres).
 * If Docker is unavailable, tests are skipped gracefully.
 *
 * Design doc §9.3 guarantees tested here:
 *  - Simultaneous claims from two workers: only one succeeds, the other gets null
 *  - Already-completed step → second claim returns null (no re-execution)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';

// ─── Docker availability guard ────────────────────────────────────────────────
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !isDockerAvailable();
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('claim.service integration (Testcontainers)', () => {
  let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
  let prisma: import('@prisma/client').PrismaClient;
  let claim: typeof import('../../services/claim.service').claim;

  const DB_PACKAGE_DIR = path.resolve(__dirname, '../../../../packages/db');

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('zapier_clone_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;

    // Run Prisma migrations against the test container
    execSync('npx prisma migrate deploy', {
      cwd: DB_PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
    });

    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    const claimModule = await import('../../services/claim.service');
    claim = claimModule.claim;
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it('simultaneous claim: first caller wins, second gets null', async () => {
    // Seed: create user, connector (only fields that exist in schema), trigger, zap, step, run
    const user = await prisma.user.create({
      data: { name: 'Test', email: `claim-test-${Date.now()}@test.com`, passwordHash: 'x' },
    });

    await prisma.connector.upsert({
      where: { id: 'razorpay' },
      update: {},
      create: {
        id: 'razorpay',
        name: 'Razorpay',
        authType: 'api_key',
        // baseUrl and webhookSignatureHeader are NOT in the Prisma schema
        // (they only exist in the DB migration SQL, not surfaced as Prisma fields)
        scopes: [],
      },
    });

    await prisma.availableTrigger.upsert({
      where: { id: 'razorpay:payment-captured' },
      update: {},
      create: {
        id: 'razorpay:payment-captured',
        connectorId: 'razorpay',
        name: 'Payment Captured',
        // payloadSchema is the Prisma field name (not outputSchema)
        payloadSchema: {},
      },
    });

    const zap = await prisma.zap.create({
      data: { name: 'Test Zap', userId: user.id, isActive: true },
    });

    const zapStep = await prisma.zapStep.create({
      data: {
        zapId: zap.id,
        stepType: 'trigger',
        position: 0,
        availableTriggerId: 'razorpay:payment-captured',
        config: {},
        webhookSecret: 'secret',
      },
    });

    // ZapRun requires webhookEventId (unique, FK to webhook_events)
    // Create a webhook event first
    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        zapId: zap.id,
        eventId: `claim-evt-${Date.now()}-1`,
        payload: {},
      },
    });

    const zapRun = await prisma.zapRun.create({
      data: {
        zapId: zap.id,
        webhookEventId: webhookEvent.id,
        status: 'in_progress',
        stepSnapshot: [],
      },
    });

    // Simulate two workers racing to claim the same step
    const [result1, result2] = await Promise.all([
      claim(zapRun.id, zapStep.id),
      claim(zapRun.id, zapStep.id),
    ]);

    // Exactly one should win the INSERT race
    const wins = [result1, result2].filter(r => r !== null).length;
    expect(wins).toBe(1);
  });

  it('already-completed step returns null (no re-execution)', async () => {
    const user = await prisma.user.create({
      data: { name: 'Test2', email: `claim-done-${Date.now()}@test.com`, passwordHash: 'x' },
    });

    await prisma.connector.upsert({
      where: { id: 'razorpay' },
      update: {},
      create: { id: 'razorpay', name: 'Razorpay', authType: 'api_key', scopes: [] },
    });

    await prisma.availableTrigger.upsert({
      where: { id: 'razorpay:payment-captured' },
      update: {},
      create: {
        id: 'razorpay:payment-captured',
        connectorId: 'razorpay',
        name: 'Payment Captured',
        payloadSchema: {},
      },
    });

    const zap = await prisma.zap.create({
      data: { name: 'Done Zap', userId: user.id, isActive: true },
    });

    const zapStep = await prisma.zapStep.create({
      data: {
        zapId: zap.id,
        stepType: 'trigger',
        position: 0,
        availableTriggerId: 'razorpay:payment-captured',
        config: {},
        webhookSecret: 'secret',
      },
    });

    const webhookEvent = await prisma.webhookEvent.create({
      data: {
        zapId: zap.id,
        eventId: `claim-done-evt-${Date.now()}`,
        payload: {},
      },
    });

    const zapRun = await prisma.zapRun.create({
      data: {
        zapId: zap.id,
        webhookEventId: webhookEvent.id,
        status: 'in_progress',
        stepSnapshot: [],
      },
    });

    // First claim succeeds
    const first = await claim(zapRun.id, zapStep.id);
    expect(first).not.toBeNull();

    // Mark it completed
    await prisma.zapRunStep.update({
      where: { id: first!.id },
      data: { status: 'completed' },
    });

    // Second claim on same step should return null — already done
    const second = await claim(zapRun.id, zapStep.id);
    expect(second).toBeNull();
  });
});
