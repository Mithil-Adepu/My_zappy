import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

/**
 * HTTP request logger middleware (TASK-6.1).
 *
 * Logs every incoming request with method, path, status, and response time
 * using pino structured logging. Placed after helmet/cors but before routes.
 *
 * Health endpoint (/health) is intentionally excluded to avoid log noise.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health') {
    next();
    return;
  }

  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }, `${req.method} ${req.path} ${res.statusCode} ${durationMs}ms`);
  });

  next();
}
