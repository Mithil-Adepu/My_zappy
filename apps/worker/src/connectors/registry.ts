import { Credentials } from '../services/token-refresh.service';

export interface AdapterRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface AdapterResult {
  status: 'completed' | 'failed' | 'ambiguous';
  output?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface ConnectorAdapter {
  /** Full action ID — e.g. "slack:send-message". Used as the registry key. */
  actionId: string;
  /** Connector prefix — e.g. "slack". Used for OAuth/credential lookup. */
  connectorId: string;
  supportsIdempotencyKey: boolean;
  buildRequest(
    mappedPayload: Record<string, unknown>,
    credentials: Credentials,
    idempotencyKey: string,
  ): AdapterRequest;
  parseResponse(rawResponse: unknown): AdapterResult;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

import { slackSendMessageAdapter } from './slack/actions/send-message';
import { razorpayCreatePaymentAdapter } from './razorpay/actions/create-payment';
import { githubCreateIssueAdapter } from './github/actions/create-issue';

const registry = new Map<string, ConnectorAdapter>();

export function registerAdapter(adapter: ConnectorAdapter): void {
  registry.set(adapter.actionId, adapter);
}

// Register all adapters — key is the full action ID (connectorId:action-name)
registerAdapter(slackSendMessageAdapter);
registerAdapter(razorpayCreatePaymentAdapter);
registerAdapter(githubCreateIssueAdapter);

export function getAdapter(actionId: string): ConnectorAdapter {
  const adapter = registry.get(actionId);
  if (!adapter) {
    throw new Error(`No adapter registered for actionId: ${actionId}`);
  }
  return adapter;
}

