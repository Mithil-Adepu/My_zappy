import axios from 'axios';
import { prisma } from '@zapier-clone/db';
import { encrypt, decrypt } from './encryption.service';
import { env } from '../config/env';

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  externalAccountId: string;
}

interface ConnectorOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

/**
 * Returns OAuth config for a given connector.
 * Add new connectors here as they're added to the catalog.
 */
export function getOAuthConfig(connectorId: string): ConnectorOAuthConfig {
  switch (connectorId) {
    case 'slack':
      return {
        authUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        clientId: env.SLACK_CLIENT_ID ?? '',
        clientSecret: env.SLACK_CLIENT_SECRET ?? '',
        redirectUri: env.SLACK_REDIRECT_URI ?? '',
        scopes: ['chat:write', 'channels:read'],
      };
    default:
      throw new Error(`No OAuth config for connector: ${connectorId}`);
  }
}

/**
 * Builds the OAuth 2.0 authorization URL for the given connector.
 * State parameter is used to pass connectorId + userId through the redirect.
 */
export function buildAuthUrl(connectorId: string, userId: string): string {
  const config = getOAuthConfig(connectorId);
  const state = Buffer.from(JSON.stringify({ connectorId, userId })).toString('base64');
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    response_type: 'code',
    state,
  });
  return `${config.authUrl}?${params}`;
}

/**
 * Exchanges an authorization code for access + refresh tokens.
 * Returns normalized token data.
 */
export async function exchangeCode(
  connectorId: string,
  code: string,
): Promise<OAuthTokens> {
  const config = getOAuthConfig(connectorId);

  const response = await axios.post(
    config.tokenUrl,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const data = response.data;
  if (data.error) throw new Error(`OAuth error: ${data.error}`);

  // Slack-specific shape — normalize here for other connectors
  const accessToken: string =
    data.access_token ?? data.authed_user?.access_token;
  const refreshToken: string = data.refresh_token ?? '';
  const externalAccountId: string =
    data.team?.id ?? data.authed_user?.id ?? 'default';
  const expiresIn: number | undefined = data.expires_in;
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000)
    : null;

  return { accessToken, refreshToken, externalAccountId, expiresAt };
}

/**
 * Refreshes an expired OAuth access token using the stored refresh token.
 * Updates the connection in the DB with the new encrypted access token.
 */
export async function refreshAccessToken(connectionId: bigint): Promise<void> {
  const connection = await prisma.connection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { connector: true },
  });

  const config = getOAuthConfig(connection.connectorId);
  const refreshToken = decrypt(connection.refreshToken!);

  const response = await axios.post(
    config.tokenUrl,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const data = response.data;
  if (data.error) throw new Error(`Token refresh failed: ${data.error}`);

  const newAccessToken = data.access_token;
  const expiresIn: number | undefined = data.expires_in;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  await prisma.connection.update({
    where: { id: connectionId },
    data: {
      accessToken: encrypt(newAccessToken),
      ...(expiresAt && { expiresAt }),
    },
  });
}
