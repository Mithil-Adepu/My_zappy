import { Request, Response, NextFunction } from 'express';
import { prisma } from '@zapier-clone/db';

export async function listConnectors(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const connectors = await prisma.connector.findMany({
      select: {
        id: true,
        name: true,
        imageUrl: true,
        authType: true,
        supportsIdempotencyKey: true,
      },
      orderBy: { name: 'asc' },
    });
    res.json(connectors);
  } catch (err) {
    next(err);
  }
}

export async function getConnectorTriggers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const triggers = await prisma.availableTrigger.findMany({
      where: { connectorId: req.params.id },
      select: { id: true, name: true, payloadSchema: true },
    });
    res.json(triggers);
  } catch (err) {
    next(err);
  }
}

export async function getConnectorActions(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actions = await prisma.availableAction.findMany({
      where: { connectorId: req.params.id },
      select: { id: true, name: true, inputSchema: true },
    });
    res.json(actions);
  } catch (err) {
    next(err);
  }
}
