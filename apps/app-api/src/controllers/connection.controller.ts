import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@zapier-clone/db';
import { encrypt } from '../services/encryption.service';
import { buildAuthUrl, exchangeCode, verifyOAuthState } from '../services/oauth.service';
import { createError } from '../middleware/error-handler.middleware';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { env } from '../config/env';


// ─── List connections ─────────────────────────────────────────────────────────

export async function listConnections(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const connections = await prisma.connection.findMany({
      where: { userId },
      select: {
        id: true,
        connectorId: true,
        label: true,
        externalAccountId: true,
        expiresAt: true,
        createdAt: true,
        connector: { select: { name: true, imageUrl: true, authType: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Map bigints to strings for JSON serialization
    res.json(
      connections.map((c) => ({ ...c, id: c.id.toString() })),
    );
  } catch (err) {
    next(err);
  }
}

// ─── OAuth: Start flow ────────────────────────────────────────────────────────

export async function startOAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const { connectorId } = z
      .object({ connectorId: z.string() })
      .parse(req.body);

    const connector = await prisma.connector.findUnique({
      where: { id: connectorId },
    });
    if (!connector || connector.authType !== 'oauth') {
      throw createError('Connector not found or does not use OAuth', 400);
    }

    const authUrl = buildAuthUrl(connectorId, userId.toString());
    res.json({ authUrl });
  } catch (err) {
    next(err);
  }
}

// ─── OAuth: Callback ─────────────────────────────────────────────────────────

export async function oauthCallback(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { code, state } = req.query as { code: string; state: string };
    if (!code || !state) throw createError('Missing code or state', 400);

    // SECURITY: verify HMAC signature on state to prevent CSRF (TASK-2.1)
    const { connectorId, userId } = verifyOAuthState(state);

    const tokens = await exchangeCode(connectorId, code);

    // Fetch the connector name for a human-readable label (TASK-4.2)
    const connector = await prisma.connector.findUnique({ where: { id: connectorId } });
    const connectorName = connector?.name ?? connectorId;
    const label = `${connectorName} (${tokens.externalAccountId})`;

    await prisma.connection.upsert({
      where: {
        userId_connectorId_externalAccountId: {
          userId: BigInt(userId),
          connectorId,
          externalAccountId: tokens.externalAccountId,
        },
      },
      create: {
        userId: BigInt(userId),
        connectorId,
        label,
        externalAccountId: tokens.externalAccountId,
        accessToken: encrypt(tokens.accessToken),
        refreshToken: encrypt(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
      },
      update: {
        label,
        accessToken: encrypt(tokens.accessToken),
        refreshToken: encrypt(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
      },
    });

    // Redirect browser back to web app connections page to complete the OAuth flow.
    res.redirect(`${env.WEB_APP_URL}/dashboard/connections?connected=${connectorId}`);
  } catch (err) {
    next(err);
  }
}

// ─── API Key: Connect ─────────────────────────────────────────────────────────

const apiKeySchema = z.object({
  connectorId: z.string(),
  label: z.string().min(1).max(100),
  apiKey: z.string().min(1),
  apiSecret: z.string().optional(),
});

export async function connectApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const body = apiKeySchema.parse(req.body);

    const connector = await prisma.connector.findUnique({
      where: { id: body.connectorId },
    });
    if (!connector || connector.authType !== 'api_key') {
      throw createError('Connector not found or does not use API key auth', 400);
    }

    const connection = await prisma.connection.create({
      data: {
        userId,
        connectorId: body.connectorId,
        label: body.label,
        externalAccountId: 'default',
        apiKey: encrypt(body.apiKey),
        apiSecret: body.apiSecret ? encrypt(body.apiSecret) : null,
      },
      select: { id: true, connectorId: true, label: true, createdAt: true },
    });

    res.status(201).json({ ...connection, id: connection.id.toString() });
  } catch (err) {
    next(err);
  }
}

// ─── Delete connection ────────────────────────────────────────────────────────

export async function deleteConnection(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req as AuthenticatedRequest;
    const connectionId = BigInt(req.params.id);

    const connection = await prisma.connection.findUnique({
      where: { id: connectionId },
    });
    if (!connection) throw createError('Connection not found', 404);
    if (connection.userId !== userId) throw createError('Forbidden', 403);

    await prisma.connection.delete({ where: { id: connectionId } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
