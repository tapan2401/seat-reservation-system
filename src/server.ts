import express, { Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pinoHttp } from 'pino-http';
import { logger } from './utils/logger.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { AppRequest } from './types.js';
import { showsRouter } from './routes/shows.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use((req: AppRequest, res: Response, next: NextFunction) => {
  req.id = req.headers['x-request-id'] as string || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

app.use(pinoHttp({
  logger,
  genReqId: (req: any) => req.id,
  autoLogging: false,
}));

app.use('/shows', showsRouter);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(errorHandler);

app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});