import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';
import { Sentry } from '../lib/sentry';

export interface AppError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;
  const message = statusCode === 500 ? 'Internal server error' : err.message;

  if (statusCode === 500) {
    logger.error({ err }, '[app-api] unhandled 500 error');
    // Capture unexpected server errors to Sentry
    Sentry.captureException(err);
  }

  res.status(statusCode).json({ error: message });
}

export function createError(message: string, statusCode: number): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}
