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

const registry = new Map<string, ConnectorAdapter>();

export function registerAdapter(adapter: ConnectorAdapter): void {
  registry.set(adapter.connectorId, adapter);
}

export function getAdapter(actionId: string): ConnectorAdapter {
  // actionId format: "connectorId:action-name" e.g. "slack:send-message"
  const connectorId = actionId.split(':')[0];
  const adapter = registry.get(connectorId);
  if (!adapter) {
    throw new Error(`No adapter registered for connector: ${connectorId} (actionId: ${actionId})`);
  }
  return adapter;
}
