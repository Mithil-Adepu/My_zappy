/**
 * Integration test: outbox FOR UPDATE SKIP LOCKED behaviour.
 *
 * Design doc §7 guarantees:
 *  - Two relay instances polling simultaneously must NOT claim the same row.
 *  - The row that gets claimed by one relay instance is skipped by the other.
 *
 * Requires Docker. Skipped gracefully when Docker is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';

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

maybeDescribe('outbox FOR UPDATE SKIP LOCKED (Testcontainers)', () => {
  let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
  let prisma: import('@prisma/client').PrismaClient;

  const DB_PACKAGE_DIR = path.resolve(__dirname, '../../../../packages/db');

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');

    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('zapier_outbox_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const dbUrl = container.getConnectionUri();
    process.env.DATABASE_URL = dbUrl;

    execSync('npx prisma migrate deploy', {
      cwd: DB_PACKAGE_DIR,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
    });

    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  it('two concurrent pollers each get at most one of two rows (SKIP LOCKED)', async () => {
    // Seed the database
    const user = await prisma.user.create({
      data: { name: 'Test', email: `skip-locked-${Date.now()}@test.com`, passwordHash: 'x' },
    });
    const zap = await prisma.zap.create({
      data: { name: 'Skip Locked Zap', userId: user.id, isActive: true },
    });

    // Create two webhook events and two outbox rows
    const ts = Date.now();
    const [event1, event2] = await Promise.all([
      prisma.webhookEvent.create({
        data: { zapId: zap.id, eventId: `evt-skip-${ts}-1`, payload: { test: 1 } },
      }),
      prisma.webhookEvent.create({
        data: { zapId: zap.id, eventId: `evt-skip-${ts}-2`, payload: { test: 2 } },
      }),
    ]);

    await Promise.all([
      prisma.outbox.create({
        data: {
          webhookEventId: event1.id,
          eventId: `evt-skip-${ts}-1`,
          payload: { test: 1 },
          status: 'pending',
        },
      }),
      prisma.outbox.create({
        data: {
          webhookEventId: event2.id,
          eventId: `evt-skip-${ts}-2`,
          payload: { test: 2 },
          status: 'pending',
        },
      }),
    ]);

    // Simulate two concurrent relay pollers using FOR UPDATE SKIP LOCKED
    const pollerQuery = `
      WITH claimed AS (
        SELECT id FROM outbox
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox SET status = 'dispatched'
      WHERE id IN (SELECT id FROM claimed)
      RETURNING id, event_id AS "eventId"
    `;

    interface OutboxRow { id: bigint; eventId: string; }
    const [rows1, rows2] = await Promise.all([
      prisma.$queryRawUnsafe<OutboxRow[]>(pollerQuery),
      prisma.$queryRawUnsafe<OutboxRow[]>(pollerQuery),
    ]);

    // Both pollers combined should have claimed exactly 2 unique rows
    const allClaimed = [...rows1, ...rows2];
    const uniqueIds = new Set(allClaimed.map((r: OutboxRow) => r.id.toString()));

    // Each poller claims 1 row, no overlap
    expect(rows1.length + rows2.length).toBe(2);
    expect(uniqueIds.size).toBe(2);

    console.log('[test] Poller 1 claimed:', rows1.map((r: OutboxRow) => r.eventId));
    console.log('[test] Poller 2 claimed:', rows2.map((r: OutboxRow) => r.eventId));
  });
});
