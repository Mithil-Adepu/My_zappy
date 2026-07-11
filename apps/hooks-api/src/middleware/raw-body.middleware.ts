import { Request, Response, NextFunction } from 'express';

/**
 * Captures the raw request body as a Buffer BEFORE any JSON parsing.
 * This is critical for HMAC-SHA256 webhook signature verification —
 * once the body is parsed as JSON, the exact byte sequence is lost.
 *
 * Attach this middleware BEFORE express.json() on webhook routes.
 */
export function rawBodyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const chunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on('end', () => {
    (req as Request & { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });

  req.on('error', next);
}
