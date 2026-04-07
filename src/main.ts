import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cookieParser = require('cookie-parser');
import { AppModule } from './app.module';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { validateRedisEnv } from './config/env-validation';

async function bootstrap() {
  console.log('[Bootstrap] Starting...');
  validateRedisEnv();
  console.log('[Bootstrap] Creating NestJS app...');
  const app = await NestFactory.create(AppModule);
  console.log('[Bootstrap] NestJS app created, configuring...');
  app.useLogger(app.get(Logger));
  const logger = app.get(Logger);

  app.use(cookieParser());

  app.enableCors({
    origin: (origin, callback) => {
      const allowed = [
        process.env.FRONTEND_URL,
        'http://localhost:3000',
        'http://localhost:3001',
      ].filter(Boolean);
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked: ${origin}`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableShutdownHooks();

  // Run pending migrations on startup
  const { PrismaService } = require('./database/prisma.service');
  const prisma = app.get(PrismaService);
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`);
    await prisma.$executeRawUnsafe(`ALTER TABLE realized_gains ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL`);
    logger.log('Soft-delete migration completed', 'Bootstrap');
  } catch (e) {
    logger.error('Soft-delete migration failed', e, 'Bootstrap');
  }

  const port = process.env.PORT ?? 3000;
  console.log(`[Bootstrap] Calling app.listen on port ${port}...`);
  await app.listen(port);
  logger.log(`Application listening on port ${port}`, 'Bootstrap');
}
bootstrap();
