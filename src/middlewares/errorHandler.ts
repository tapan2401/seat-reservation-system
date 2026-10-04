import { Response, NextFunction } from 'express';
import { AppRequest } from '../types.js';
import { logger } from '../utils/logger.js';

export const errorHandler = (err: any, req: AppRequest, res: Response, next: NextFunction): void => {
  const reqId = req.id || 'unknown';

  // 40P01: Postgres Deadlock Detected
  // 55P03: Postgres Lock Not Available (Timeout)
  if (err.code === '40P01' || err.code === '55P03') {
    logger.warn({ reqId, errCode: err.code }, 'Database lock contention');
    res.status(409).json({
      error: 'Conflict',
      message: 'High contention on requested seats. Please try again.',
      reason: 'LOCK_CONTENTION'
    });
    return;
  }

  // Zod Validation Errors
  if (err.name === 'ZodError') {
    res.status(400).json({
      error: 'Bad Request',
      details: err.errors
    });
    return;
  }

  // Unhandled Exceptions
  logger.error({ reqId, err: err.message, stack: err.stack }, 'Unhandled Server Error');
  res.status(500).json({ error: 'Internal Server Error' });
};