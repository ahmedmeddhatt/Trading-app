import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      log: [
        { emit: 'stdout', level: 'query' },
        { emit: 'stdout', level: 'info' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
  }
  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Prisma] DB connection failed on startup: ${msg}`);
      // Do NOT rethrow — let the app start; requests will receive 503 via the exception filter
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
