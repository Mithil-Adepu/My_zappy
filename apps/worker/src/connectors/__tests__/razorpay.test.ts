import { describe, it, expect } from 'vitest';
import { razorpayCreatePaymentAdapter } from '../razorpay/actions/create-payment';

describe('Razorpay create-payment adapter — contract tests', () => {
  const creds = { type: 'api_key' as const, apiKey: 'rzp_test_key', apiSecret: 'rzp_test_secret' };
  const idempotencyKey = 'order-abc-123';

  describe('buildRequest', () => {
    it('builds correct URL and method', () => {
      const req = razorpayCreatePaymentAdapter.buildRequest(
        { amount: 50000, currency: 'INR', description: 'Test payment' },
        creds, idempotencyKey,
      );
      expect(req.url).toBe('https://api.razorpay.com/v1/payment_links');
      expect(req.method).toBe('POST');
    });

    it('sets Basic auth header correctly (key:secret base64)', () => {
      const req = razorpayCreatePaymentAdapter.buildRequest({ amount: 100, currency: 'INR' }, creds, idempotencyKey);
      const expected = Buffer.from('rzp_test_key:rzp_test_secret').toString('base64');
      expect(req.headers.Authorization).toBe(`Basic ${expected}`);
    });

    it('includes X-Idempotency-Key header', () => {
      const req = razorpayCreatePaymentAdapter.buildRequest({ amount: 100, currency: 'INR' }, creds, idempotencyKey);
      expect(req.headers['X-Idempotency-Key']).toBe(idempotencyKey);
    });

    it('maps amount, currency, description in body', () => {
      const req = razorpayCreatePaymentAdapter.buildRequest(
        { amount: 50000, currency: 'INR', description: 'Subscription' }, creds, idempotencyKey,
      );
      expect(req.body?.amount).toBe(50000);
      expect(req.body?.currency).toBe('INR');
      expect(req.body?.description).toBe('Subscription');
    });

    it('throws for non-api_key credentials', () => {
      const oauthCreds = { type: 'oauth' as const, accessToken: 't', refreshToken: '' };
      expect(() => razorpayCreatePaymentAdapter.buildRequest({}, oauthCreds, '')).toThrow('API key');
    });
  });

  describe('parseResponse', () => {
    it('returns completed for successful response (has id, no error)', () => {
      const result = razorpayCreatePaymentAdapter.parseResponse({
        id: 'plink_abc', entity: 'payment_link', amount: 50000, currency: 'INR', status: 'created',
      });
      expect(result.status).toBe('completed');
      expect(result.output?.id).toBe('plink_abc');
    });

    it('returns failed when error field present', () => {
      const result = razorpayCreatePaymentAdapter.parseResponse({
        error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be greater than 0' },
      });
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('BAD_REQUEST_ERROR');
      expect(result.errorMessage).toContain('amount must be');
    });
  });

  it('supportsIdempotencyKey is true', () => {
    expect(razorpayCreatePaymentAdapter.supportsIdempotencyKey).toBe(true);
  });
});
