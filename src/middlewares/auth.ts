import { Response, NextFunction } from 'express';
import { AppRequest } from '../types.js';

export const requireAuth = (req: AppRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Bearer token'
    });
    return;
  }
  const token = authHeader.split(' ')[1];
  const role = token.startsWith('admin_') ? 'admin' : 'user';
  req.user = { id: token, role };
  next();
};

export const requireAdmin = (req: AppRequest, res: Response, next: NextFunction): void => {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required to perform this action'
    });
    return;
  }
  next();
};