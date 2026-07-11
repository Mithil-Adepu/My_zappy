import { Router } from 'express';
import {
  listConnectors,
  getConnectorTriggers,
  getConnectorActions,
} from '../controllers/connectors.controller';

export const connectorsRouter = Router();

connectorsRouter.get('/', listConnectors);
connectorsRouter.get('/:id/triggers', getConnectorTriggers);
connectorsRouter.get('/:id/actions', getConnectorActions);
