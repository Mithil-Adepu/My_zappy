/**
 * Auth controller tests — signup, login, me
 *
 * Strategy: mock @zapier-clone/db (Prisma), bcryptjs, and jsonwebtoken
 * so we can test the controller logic without a real database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@zapier-clone/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$hashed$'),
    compare: vi.fn(),
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('mock.jwt.token'),
    verify: vi.fn(),
  },
}));

import { prisma } from '@zapier-clone/db';
import bcrypt from 'bcryptjs';
import { signup, login } from '../controllers/auth.controller';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

const next: NextFunction = vi.fn() as unknown as NextFunction;

// ─── signup ────────────────────────────────────────────────────────────────────

describe('signup', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 if body is invalid (no email)', async () => {
    const req = { body: { name: 'Test', password: 'password123' } } as Request;
    const res = makeMockRes();
    await signup(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 if password is too short', async () => {
    const req = { body: { name: 'Test', email: 'test@example.com', password: 'short' } } as Request;
    const res = makeMockRes();
    await signup(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('calls next with 409 error if email already exists', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 1n, name: 'Existing', email: 'exists@example.com',
      passwordHash: '$hashed$', createdAt: new Date(),
    });
    const req = {
      body: { name: 'Test', email: 'exists@example.com', password: 'password123' },
    } as Request;
    const res = makeMockRes();
    await signup(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Email already in use', statusCode: 409 }),
    );
  });

  it('creates user and returns token + user on success', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: 42n, name: 'Test User', email: 'new@example.com',
    } as any);

    const req = {
      body: { name: 'Test User', email: 'new@example.com', password: 'password123' },
    } as Request;
    const res = makeMockRes();
    await signup(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    const body = vi.mocked(res.json).mock.calls[0][0] as { token: string; user: { id: string } };
    expect(body.token).toBe('mock.jwt.token');
    expect(body.user.id).toBe('42');
  });
});

// ─── login ────────────────────────────────────────────────────────────────────

describe('login', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 if email is missing', async () => {
    const req = { body: { password: 'password123' } } as Request;
    const res = makeMockRes();
    await login(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('calls next with 401 if user not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const req = { body: { email: 'nobody@example.com', password: 'pw' } } as Request;
    const res = makeMockRes();
    await login(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('calls next with 401 if password is wrong', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 1n, name: 'User', email: 'user@example.com',
      passwordHash: '$hashed$', createdAt: new Date(),
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

    const req = { body: { email: 'user@example.com', password: 'wrong' } } as Request;
    const res = makeMockRes();
    await login(req, res, next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('returns token + user on valid credentials', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 7n, name: 'Valid User', email: 'valid@example.com',
      passwordHash: '$hashed$', createdAt: new Date(),
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const req = { body: { email: 'valid@example.com', password: 'correctpass' } } as Request;
    const res = makeMockRes();
    await login(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'mock.jwt.token' }),
    );
    const body = vi.mocked(res.json).mock.calls[0][0] as { user: { id: string } };
    expect(body.user.id).toBe('7');
  });
});
