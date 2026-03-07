import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';

export interface SuccessResponse<T> {
  success: true;
  data: T;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, SuccessResponse<T>>
{
  intercept(
    ctx: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessResponse<T>> {
    const req = ctx.switchToHttp().getRequest<Request>();
    // SSE connections must not be wrapped — they stream raw text/event-stream
    if (req?.headers?.accept?.includes('text/event-stream')) {
      return next.handle() as Observable<SuccessResponse<T>>;
    }
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
