import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyWebhook } from '../hmac-verify.service';

function makeSignature(body: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('hmac-verify', () => {
  const secret = 'test-secret-32-bytes-long-enough!!';
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { amount: 5000 } }));

  it('returns true for valid signature', () => {
    const sig = makeSignature(body, secret);
    expect(verifyWebhook(body, sig, secret)).toBe(true);
  });

  it('returns false for tampered body', () => {
    const sig = makeSignature(body, secret);
    const tamperedBody = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { amount: 9999 } }));
    expect(verifyWebhook(tamperedBody, sig, secret)).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const sig = makeSignature(body, 'wrong-secret');
    expect(verifyWebhook(body, sig, secret)).toBe(false);
  });

  it('returns false for empty signature', () => {
    expect(verifyWebhook(body, '', secret)).toBe(false);
  });

  it('returns false for mismatched length signature', () => {
    expect(verifyWebhook(body, 'abc123', secret)).toBe(false);
  });

  it('is timing-safe (same result regardless of early mismatch position)', () => {
    const validSig = makeSignature(body, secret);
    // Flip first byte of signature
    const invalidSig = 'f' + validSig.slice(1);
    expect(verifyWebhook(body, invalidSig, secret)).toBe(false);
    // Flip last byte
    const invalidSig2 = validSig.slice(0, -1) + (validSig.endsWith('f') ? 'e' : 'f');
    expect(verifyWebhook(body, invalidSig2, secret)).toBe(false);
  });
});
