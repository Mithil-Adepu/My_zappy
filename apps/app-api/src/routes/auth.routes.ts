import { Router } from 'express';
import { signup, login, me } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';

export const authRouter = Router();

authRouter.post('/signup', signup);
authRouter.post('/login', login);
authRouter.get('/me', authMiddleware, me);
