import { ConnectorAdapter, AdapterRequest, AdapterResult } from '../../registry';
import { Credentials } from '../../../services/token-refresh.service';

interface SlackResponse {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export const slackSendMessageAdapter: ConnectorAdapter = {
  actionId: 'slack:send-message',
  connectorId: 'slack',
  // Slack has no idempotency key support — ambiguous timeouts rely solely
  // on the ambiguous status path. Design doc §10.
  supportsIdempotencyKey: false,

  buildRequest(
    mappedPayload: Record<string, unknown>,
    credentials: Credentials,
    _idempotencyKey: string, // intentionally unused — Slack has no such mechanism
  ): AdapterRequest {
    if (credentials.type !== 'oauth') {
      throw new Error('Slack requires OAuth credentials');
    }

    return {
      url: 'https://slack.com/api/chat.postMessage',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: {
        channel: mappedPayload['channel'] as string,
        text: mappedPayload['text'] as string,
      },
    };
  },

  parseResponse(rawResponse: unknown): AdapterResult {
    const data = rawResponse as SlackResponse;

    if (data.ok) {
      return {
        status: 'completed',
        output: {
          ok: data.ok,
          ts: data.ts,
          channel: data.channel,
        },
      };
    }

    return {
      status: 'failed',
      errorCode: 'SLACK_API_ERROR',
      errorMessage: data.error ?? 'Unknown Slack error',
    };
  },
};
