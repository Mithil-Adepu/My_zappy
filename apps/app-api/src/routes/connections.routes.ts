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

// /oauth/callback is a browser redirect from Slack/etc — no JWT token is
// sent, and none is needed: the HMAC-signed `state` param identifies the user.
connectionsRouter.get('/oauth/callback', oauthCallback);

// All other connection routes require a valid JWT.
connectionsRouter.get('/',          authMiddleware, listConnections);
connectionsRouter.post('/oauth/start', authMiddleware, startOAuth);
connectionsRouter.post('/api-key',  authMiddleware, connectApiKey);
connectionsRouter.delete('/:id',   authMiddleware, deleteConnection);
