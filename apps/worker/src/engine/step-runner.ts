import axios, { AxiosError } from 'axios';
import { apply as substituteTemplates } from '../engine/template-substitution';
import { validateMappedPayload } from '../engine/payload-validator';
import { getAdapter, AdapterResult } from '../connectors/registry';
import { getCredentials, refreshToken } from '../services/token-refresh.service';
import { checkAndConsume, releaseWithDelay } from './step-runner-helpers';
import { env } from '../config/env';

export interface StepRunResult {
  status: 'completed' | 'failed' | 'ambiguous' | 'processing';
  output?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  unresolvedFields?: string[];
}

export interface ZapStepWithAction {
  id: bigint;
  availableActionId: string | null;
  connectionId: bigint | null;
  config: Record<string, unknown>;
  availableAction?: {
    inputSchema: Record<string, unknown> | null;
  } | null;
}

/**
 * Runs a single action step. Implements §9.5 of the design doc.
 *
 * Order:
 *  1. Rate limit check → requeue if exceeded
 *  2. Template substitution
 *  3. AJV validation (relaxed for unresolved fields)
 *  4. Get credentials (decrypted)
 *  5. Build request + send
 *  6. On 401+OAuth: refresh once, retry
 *  7. On 401+API key: fail immediately (no refresh flow)
 *  8. On timeout/server error: ambiguous
 */
export async function runStep(
  step: ZapStepWithAction,
  payloadContext: Record<string, unknown>,
  idempotencyKey: string,
  claimedRowId: bigint,
): Promise<StepRunResult> {
  if (!step.availableActionId || !step.connectionId) {
    return {
      status: 'failed',
      errorCode: 'STEP_MISCONFIGURED',
      errorMessage: 'Step is missing availableActionId or connectionId',
    };
  }

  // 1. Rate limit check
  const underLimit = await checkAndConsume(
    step.connectionId,
    env.WORKER_RATE_LIMIT_PER_CONNECTION,
    env.WORKER_RATE_LIMIT_WINDOW_SECONDS,
  );

  if (!underLimit) {
    // Requeue — not a failure, just backpressure
    await releaseWithDelay(claimedRowId);
    return { status: 'processing' };
  }

  // 2. Template substitution
  const { mappedPayload, unresolvedFields } = substituteTemplates(
    step.config,
    payloadContext,
  );

  // 3. AJV validation (relaxed for unresolved fields)
  const validation = validateMappedPayload(
    mappedPayload,
    step.availableAction?.inputSchema ?? null,
    unresolvedFields,
  );

  if (!validation.success) {
    return {
      status: 'failed',
      errorCode: validation.errorCode,
      errorMessage: validation.errorMessage,
      unresolvedFields,
    };
  }

  // 4. Get credentials
  const credentials = await getCredentials(step.connectionId);

  // 5. Build request + send (with retry on 401)
  return executeWithRefresh(
    step,
    mappedPayload,
    credentials,
    idempotencyKey,
    unresolvedFields,
    false, // isRetry
  );
}

async function executeWithRefresh(
  step: ZapStepWithAction,
  mappedPayload: Record<string, unknown>,
  credentials: Awaited<ReturnType<typeof getCredentials>>,
  idempotencyKey: string,
  unresolvedFields: string[],
  isRetry: boolean,
): Promise<StepRunResult> {
  const adapter = getAdapter(step.availableActionId!);
  const request = adapter.buildRequest(mappedPayload, credentials, idempotencyKey);

  try {
    const response = await axios({
      url: request.url,
      method: request.method,
      headers: request.headers,
      data: request.body,
      timeout: 30000,
    });

    const result = adapter.parseResponse(response.data);
    return { ...result, unresolvedFields };
  } catch (err) {
    const axiosErr = err as AxiosError;

    if (axiosErr.response?.status === 401 && !isRetry) {
      if (credentials.type === 'oauth') {
        // Lazy refresh — 401 means nothing executed server-side
        await refreshToken(step.connectionId!);
        const newCredentials = await getCredentials(step.connectionId!);
        return executeWithRefresh(step, mappedPayload, newCredentials, idempotencyKey, unresolvedFields, true);
      }
      // API key — no refresh flow. Key is wrong or revoked.
      return {
        status: 'failed',
        errorCode: 'INVALID_API_KEY',
        errorMessage: 'Stored API key was rejected. Reconnect this app.',
        unresolvedFields,
      };
    }

    if (axiosErr.code === 'ECONNABORTED' || (axiosErr.response?.status ?? 0) >= 500) {
      // Timeout or server error — outcome unknown
      return {
        status: 'ambiguous',
        errorCode: 'AMBIGUOUS_TIMEOUT',
        errorMessage: 'Request timed out or server errored with no confirmation. Outcome unknown.',
        unresolvedFields,
      };
    }

    return {
      status: 'failed',
      errorCode: 'REQUEST_ERROR',
      errorMessage: axiosErr.message,
      unresolvedFields,
    };
  }
}
