import { Router } from 'express';
import { rawBodyMiddleware } from '../middleware/raw-body.middleware';
import { handleWebhook } from '../controllers/webhook.controller';

export const webhookRouter: import("express").Router = Router();

// rawBodyMiddleware MUST come before any body-parser — it captures the raw bytes
webhookRouter.post('/:zapId/:stepId', rawBodyMiddleware, handleWebhook);
