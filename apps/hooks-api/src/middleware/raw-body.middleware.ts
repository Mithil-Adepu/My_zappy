import { Request, Response, NextFunction } from 'express';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Captures the raw request body as a Buffer BEFORE any JSON parsing.
 * This is critical for HMAC-SHA256 webhook signature verification —
 * once the body is parsed as JSON, the exact byte sequence is lost.
 *
 * Attach this middleware BEFORE express.json() on webhook routes.
 * Enforces a 5MB body size limit to prevent memory exhaustion.
 */
export function rawBodyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  req.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      res.status(413).json({ error: 'Payload too large (max 5MB)' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    (req as Request & { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });

  req.on('error', next);
}
