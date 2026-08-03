// Entity interfaces that mirror the Prisma schema exactly.
// These are used across all services (app-api, worker, relay, web).

export interface User {
  id: bigint;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface Connector {
  id: string;
  name: string;
  imageUrl: string | null;
  authType: 'oauth' | 'api_key';
  authUrl: string | null;
  tokenUrl: string | null;
  scopes: string[];
  supportsIdempotencyKey: boolean;
}

export interface AvailableTrigger {
  id: string;
  connectorId: string;
  name: string;
  payloadSchema: Record<string, unknown> | null;
}

export interface AvailableAction {
  id: string;
  connectorId: string;
  name: string;
  inputSchema: Record<string, unknown> | null;
}

export interface Connection {
  id: bigint;
  userId: bigint;
  connectorId: string;
  label: string;
  externalAccountId: string;
  /** Encrypted at rest. Populated for oauth connections. */
  accessToken: string | null;
  /** Encrypted at rest. Populated for oauth connections. */
  refreshToken: string | null;
  /** Encrypted at rest. Populated for api_key connections. */
  apiKey: string | null;
  /** Encrypted at rest. Some providers need both key+secret (e.g. Razorpay). */
  apiSecret: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface Zap {
  id: bigint;
  userId: bigint;
  name: string;
  isActive: boolean;
  maxRunsPerHour: number;
  createdAt: Date;
}

export interface ZapStep {
  id: bigint;
  zapId: bigint;
  stepType: 'trigger' | 'action' | 'filter';
  position: number;
  availableTriggerId: string | null;
  availableActionId: string | null;
  connectionId: bigint | null;
  config: Record<string, unknown>;
  webhookSecret: string | null;
  createdAt: Date;
}

export interface WebhookEvent {
  id: bigint;
  eventId: string;
  zapId: bigint;
  payload: Record<string, unknown>;
  receivedAt: Date;
}

export interface Outbox {
  id: bigint;
  webhookEventId: bigint;
  eventId: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'dispatched' | 'consumed' | 'dead';
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface ZapRun {
  id: bigint;
  zapId: bigint;
  webhookEventId: bigint;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'filtered';
  stepSnapshot: ZapStep[] | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface ZapRunStep {
  id: bigint;
  zapRunId: bigint;
  zapStepId: bigint;
  status: 'processing' | 'completed' | 'failed' | 'ambiguous';
  output: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string;
  claimedAt: Date | null;
  workerId: string | null;
  executedAt: Date;
}
