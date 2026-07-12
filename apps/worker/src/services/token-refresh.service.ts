import axios from 'axios';
import { prisma } from '@zapier-clone/db';
import { env } from '../config/env';
import { encrypt, decrypt } from './encrypt.helper';

export type Credentials =
  | { type: 'oauth'; accessToken: string; refreshToken: string }
  | { type: 'api_key'; apiKey: string; apiSecret: string | null };

/**
 * Fetches and decrypts credentials for a connection.
 * Returns a discriminated union based on the connector's auth type.
 */
export async function getCredentials(connectionId: bigint): Promise<Credentials> {
  const connection = await prisma.connection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { connector: { select: { authType: true } } },
  });

  if (connection.connector.authType === 'api_key') {
    return {
      type: 'api_key',
      apiKey: decrypt(connection.apiKey!),
      apiSecret: connection.apiSecret ? decrypt(connection.apiSecret) : null,
    };
  }

  return {
    type: 'oauth',
    accessToken: decrypt(connection.accessToken!),
    refreshToken: decrypt(connection.refreshToken!),
  };
}

/**
 * Refreshes an expired OAuth token.
 * Called lazily on 401 during execution (primary guarantee).
 */
export async function refreshToken(connectionId: bigint): Promise<void> {
  const connection = await prisma.connection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { connector: { select: { tokenUrl: true, authType: true } } },
  });

  if (connection.connector.authType !== 'oauth' || !connection.refreshToken) {
    throw new Error('Cannot refresh: not an OAuth connection');
  }

  // Token URL and client credentials come from app-api env vars in production.
  // For the worker, we use the stored refresh token and make a generic request.
  // In a real deployment, the OAuth client_id/secret would be in worker env too.
  const tokenUrl = connection.connector.tokenUrl!;
  const storedRefreshToken = decrypt(connection.refreshToken);

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({
      refresh_token: storedRefreshToken,
      grant_type: 'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const data = response.data;
  if (data.error) throw new Error(`Token refresh failed: ${data.error}`);

  await prisma.connection.update({
    where: { id: connectionId },
    data: {
      accessToken: encrypt(data.access_token),
      ...(data.expires_in && {
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
      }),
    },
  });
}

