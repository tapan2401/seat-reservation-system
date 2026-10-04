import { Request } from 'express';

export interface AppRequest extends Request {
  user?: {
    id: string;
    role: 'admin' | 'user';
  };
}