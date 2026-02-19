import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const id = (req.headers['x-correlation-id'] as string) ?? randomUUID();
    (req as any).correlationId = id;
    res.setHeader('x-correlation-id', id);
    next();
  }
}
