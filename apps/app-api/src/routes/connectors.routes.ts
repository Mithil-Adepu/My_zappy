import { Router } from 'express';
import {
  listConnectors,
  getConnectorTriggers,
  getConnectorActions,
} from '../controllers/connectors.controller';

export const connectorsRouter: import("express").Router = Router();

connectorsRouter.get('/', listConnectors);
connectorsRouter.get('/:id/triggers', getConnectorTriggers);
connectorsRouter.get('/:id/actions', getConnectorActions);
