import { Router } from 'express';
import {
  listZaps,
  getZap,
  createZap,
  updateZap,
  deleteZap,
  addStep,
  updateStep,
  deleteStep,
  getWebhookSecret,
} from '../controllers/zap.controller';
import { authMiddleware } from '../middleware/auth.middleware';

export const zapsRouter: import("express").Router = Router();

zapsRouter.use(authMiddleware);

zapsRouter.get('/', listZaps);
zapsRouter.post('/', createZap);
zapsRouter.get('/:id', getZap);
zapsRouter.patch('/:id', updateZap);
zapsRouter.delete('/:id', deleteZap);

// Step sub-routes
zapsRouter.post('/:id/steps', addStep);
zapsRouter.patch('/:id/steps/:stepId', updateStep);
zapsRouter.delete('/:id/steps/:stepId', deleteStep);

// Webhook secret — separate endpoint so it is never included in GET /zap/:id
zapsRouter.get('/:id/steps/:stepId/webhook-secret', getWebhookSecret);
