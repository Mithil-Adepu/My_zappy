import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '@zapier-clone/db';
import { env } from '../config/env';
import { createError } from '../middleware/error-handler.middleware';

const signupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

function issueToken(userId: bigint): string {
  return jwt.sign({ sub: userId.toString() }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

export async function signup(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = signupSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.flatten().fieldErrors });
      return;
    }
    const { name, email, password } = body.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw createError('Email already in use', 409);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { name, email, passwordHash },
      select: { id: true, name: true, email: true },
    });

    const token = issueToken(user.id);
    res.status(201).json({
      token,
      user: { id: user.id.toString(), name: user.name, email: user.email },
    });
  } catch (err) {
    next(err);
  }
}

export async function login(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.flatten().fieldErrors });
      return;
    }
    const { email, password } = body.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw createError('Invalid credentials', 401);
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw createError('Invalid credentials', 401);
    }

    const token = issueToken(user.id);
    res.json({
      token,
      user: { id: user.id.toString(), name: user.name, email: user.email },
    });
  } catch (err) {
    next(err);
  }
}

export async function me(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as Request & { userId: bigint };
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    res.json({ id: user.id.toString(), name: user.name, email: user.email, createdAt: user.createdAt });
  } catch (err) {
    next(err);
  }
}
