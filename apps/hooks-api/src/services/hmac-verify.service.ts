import crypto from 'crypto';

/**
 * Verifies a webhook's HMAC-SHA256 signature.
 * Exactly as specified in design doc §5.
 *
 * Order matters: capture rawBody → verify → parse → ingest.
 * A 401 is returned on failure with NO DB write.
 *
 * @param rawBody - The raw request body as a Buffer (before JSON parsing)
 * @param receivedSignature - The hex signature from the request header
 * @param secret - The webhook_secret stored on the zap_step
 * @returns true if valid, false if invalid
 */
export function verifyWebhook(
  rawBody: Buffer,
  receivedSignature: string,
  secret: string,
): boolean {
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const computedBuf = Buffer.from(computed, 'hex');
  const receivedBuf = Buffer.from(receivedSignature, 'hex');

  // Length guard before timingSafeEqual (required — throws if lengths differ)
  if (computedBuf.length !== receivedBuf.length) return false;

  return crypto.timingSafeEqual(computedBuf, receivedBuf);
}
