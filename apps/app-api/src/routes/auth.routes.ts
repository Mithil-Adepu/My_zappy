import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { signup, login, me } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';

export const authRouter: import("express").Router = Router();

/** 10 attempts per 15 min per IP — brute-force protection */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please try again in 15 minutes.' },
});

authRouter.post('/signup', authLimiter, signup);
authRouter.post('/login', authLimiter, login);
authRouter.get('/me', authMiddleware, me);
