import { ConnectorAdapter, AdapterRequest, AdapterResult } from '../../registry';
import { Credentials } from '../../../services/token-refresh.service';

interface RazorpayPaymentResponse {
  id?: string;
  entity?: string;
  amount?: number;
  currency?: string;
  status?: string;
  error?: { description?: string; code?: string };
}

export const razorpayCreatePaymentAdapter: ConnectorAdapter = {
  actionId: 'razorpay:create-payment',
  connectorId: 'razorpay',
  // Razorpay supports X-Idempotency-Key — provider-side dedup on retry.
  // Design doc §10.
  supportsIdempotencyKey: true,

  buildRequest(
    mappedPayload: Record<string, unknown>,
    credentials: Credentials,
    idempotencyKey: string,
  ): AdapterRequest {
    if (credentials.type !== 'api_key') {
      throw new Error('Razorpay requires API key credentials');
    }

    // Razorpay uses HTTP Basic Auth: key_id:key_secret
    const basicAuth = Buffer.from(
      `${credentials.apiKey}:${credentials.apiSecret ?? ''}`,
    ).toString('base64');

    return {
      url: 'https://api.razorpay.com/v1/payment_links',
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: {
        amount: mappedPayload['amount'] as number,
        currency: mappedPayload['currency'] as string,
        description: (mappedPayload['description'] as string) ?? '',
      },
    };
  },

  parseResponse(rawResponse: unknown): AdapterResult {
    const data = rawResponse as RazorpayPaymentResponse;

    if (data.error) {
      return {
        status: 'failed',
        errorCode: data.error.code ?? 'RAZORPAY_ERROR',
        errorMessage: data.error.description ?? 'Unknown Razorpay error',
      };
    }

    return {
      status: 'completed',
      output: {
        id: data.id,
        entity: data.entity,
        amount: data.amount,
        currency: data.currency,
        status: data.status,
      },
    };
  },
};
