import { Router } from 'express';
import {
  listConnections,
  startOAuth,
  oauthCallback,
  connectApiKey,
  deleteConnection,
} from '../controllers/connection.controller';
import { authMiddleware } from '../middleware/auth.middleware';

export const connectionsRouter: import("express").Router = Router();

connectionsRouter.use(authMiddleware);

connectionsRouter.get('/', listConnections);
connectionsRouter.post('/oauth/start', startOAuth);
connectionsRouter.get('/oauth/callback', oauthCallback);
connectionsRouter.post('/api-key', connectApiKey);
connectionsRouter.delete('/:id', deleteConnection);
