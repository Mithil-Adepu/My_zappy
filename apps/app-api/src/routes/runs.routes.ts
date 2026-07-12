import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { listRunsForZap, getRun } from '../controllers/runs.controller';

export const runsRouter: Router = Router();

runsRouter.use(authMiddleware);

// GET /runs/zap/:zapId — paginated run list
runsRouter.get('/zap/:zapId', listRunsForZap);

// GET /runs/:runId — full run detail with all steps
runsRouter.get('/:runId', getRun);
