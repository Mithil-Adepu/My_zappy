const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('zapier_token');
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }

  if (res.status === 204) return null as T;
  return res.json();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const api = {
  auth: {
    signup: (body: { name: string; email: string; password: string }) =>
      request<{ token: string; user: { id: string; name: string; email: string } }>('/auth/signup', {
        method: 'POST', body: JSON.stringify(body),
      }),
    login: (body: { email: string; password: string }) =>
      request<{ token: string; user: { id: string; name: string; email: string } }>('/auth/login', {
        method: 'POST', body: JSON.stringify(body),
      }),
    me: () => request<{ id: string; name: string; email: string }>('/auth/me'),
  },

  // ─── Connectors ─────────────────────────────────────────────────────────────
  connectors: {
    list: () => request<Connector[]>('/connectors'),
    triggers: (id: string) => request<AvailableTrigger[]>(`/connectors/${id}/triggers`),
    actions: (id: string) => request<AvailableAction[]>(`/connectors/${id}/actions`),
  },

  // ─── Connections ─────────────────────────────────────────────────────────────
  connections: {
    list: () => request<Connection[]>('/connections'),
    startOAuth: (connectorId: string) =>
      request<{ authUrl: string }>('/connections/oauth/start', {
        method: 'POST', body: JSON.stringify({ connectorId }),
      }),
    connectApiKey: (body: { connectorId: string; label: string; apiKey: string; apiSecret?: string }) =>
      request<Connection>('/connections/api-key', { method: 'POST', body: JSON.stringify(body) }),
    delete: (id: string) => request<null>(`/connections/${id}`, { method: 'DELETE' }),
  },

  // ─── Zaps ─────────────────────────────────────────────────────────────────────
  zaps: {
    list: () => request<Zap[]>('/zaps'),
    get: (id: string) => request<ZapWithSteps>(`/zaps/${id}`),
    create: (body: CreateZapBody) => request<ZapWithSteps>('/zaps', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: Partial<{ name: string; isActive: boolean; maxRunsPerHour: number }>) =>
      request<Zap>(`/zaps/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string) => request<null>(`/zaps/${id}`, { method: 'DELETE' }),
    addStep: (zapId: string, body: StepInput) =>
      request<ZapStep>(`/zaps/${zapId}/steps`, { method: 'POST', body: JSON.stringify(body) }),
    updateStep: (zapId: string, stepId: string, body: { config?: Record<string, unknown>; connectionId?: string | null }) =>
      request<ZapStep>(`/zaps/${zapId}/steps/${stepId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteStep: (zapId: string, stepId: string) =>
      request<null>(`/zaps/${zapId}/steps/${stepId}`, { method: 'DELETE' }),
  },

  // ─── Runs ─────────────────────────────────────────────────────────────────────
  runs: {
    list: (zapId: string, page = 1) => request<RunsPage>(`/runs/zap/${zapId}?page=${page}`),
    get: (runId: string) => request<RunDetail>(`/runs/${runId}`),
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Connector {
  id: string; name: string; imageUrl: string | null;
  authType: 'oauth' | 'api_key'; supportsIdempotencyKey: boolean;
}
export interface AvailableTrigger { id: string; name: string; payloadSchema: Record<string, unknown> | null; }
export interface AvailableAction  { id: string; name: string; inputSchema: Record<string, unknown> | null; }
export interface Connection {
  id: string; connectorId: string; label: string; externalAccountId: string;
  expiresAt: string | null; createdAt: string;
  connector: { name: string; imageUrl: string | null; authType: 'oauth' | 'api_key' };
}
export interface Zap {
  id: string; name: string; isActive: boolean; maxRunsPerHour: number;
  createdAt: string; _count?: { steps: number };
}
export interface ZapStep {
  id: string; zapId: string; stepType: 'trigger' | 'action' | 'filter';
  position: number; availableTriggerId: string | null; availableActionId: string | null;
  connectionId: string | null; config: Record<string, unknown>;
  availableTrigger?: { id: string; name: string } | null;
  availableAction?: { id: string; name: string } | null;
}
export interface ZapWithSteps extends Zap { steps: ZapStep[]; }
export interface StepInput {
  stepType: 'trigger' | 'action' | 'filter'; position: number;
  availableTriggerId?: string | null; availableActionId?: string | null;
  connectionId?: string | null; config?: Record<string, unknown>;
}
export interface CreateZapBody { name: string; isActive?: boolean; maxRunsPerHour?: number; steps: StepInput[]; }
export interface RunsPage { runs: ZapRun[]; total: number; page: number; limit: number; }
export interface ZapRun {
  id: string; status: 'in_progress' | 'completed' | 'failed' | 'filtered';
  startedAt: string; completedAt: string | null; _count: { zapRunSteps: number };
}
export interface RunDetail extends ZapRun {
  zapRunSteps: RunStep[];
}
export interface RunStep {
  id: string; status: 'processing' | 'completed' | 'failed' | 'ambiguous';
  output: Record<string, unknown> | null; errorCode: string | null; errorMessage: string | null;
  executedAt: string;
  zapStep: {
    stepType: string; position: number;
    availableAction?: { name: string; connectorId: string } | null;
    availableTrigger?: { name: string; connectorId: string } | null;
  };
}
