import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/** Prisma error codes that indicate DB connectivity issues */
const PRISMA_DB_UNREACHABLE = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

function isPrismaError(e: unknown): e is Error & { code?: string } {
  return (
    e instanceof Error &&
    (e.constructor.name.startsWith('PrismaClient') || 'code' in (e as any))
  );
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const correlationId = (req as any).correlationId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message =
        typeof body === 'string'
          ? body
          : ((body as any).message ?? exception.message);
    } else if (isPrismaError(exception)) {
      const code = (exception as any).code as string | undefined;
      const msg = (exception as Error).message ?? '';
      const isDbDown =
        (code && PRISMA_DB_UNREACHABLE.has(code)) ||
        msg.includes("Can't reach database") ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('Connection refused') ||
        msg.includes('Tenant or user not found') ||
        msg.includes('Connection pool timeout') ||
        msg.includes('Server has closed the connection');

      if (isDbDown) {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        message =
          'Database is temporarily unavailable. Please try again later.';
      } else if (code === 'P2002') {
        status = HttpStatus.CONFLICT;
        message = 'A record with this value already exists.';
      } else if (code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        message = 'Record not found.';
      } else {
        message = 'A database error occurred.';
      }
    } else if (exception instanceof Error) {
      if (
        exception.message.includes("Can't reach database") ||
        exception.message.includes('Connection refused') ||
        exception.message.includes('ECONNREFUSED') ||
        exception.message.includes('Tenant or user not found')
      ) {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        message =
          'Database is temporarily unavailable. Please try again later.';
      }
    }

    this.logger.error(
      `[${correlationId}] ${status} ${req.method} ${req.url} — ${message}`,
    );

    res.status(status).json({
      success: false,
      message,
      statusCode: status,
    });
  }
}
