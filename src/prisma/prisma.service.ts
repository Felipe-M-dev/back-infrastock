import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString =
      process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL no está definida',
      );
    }

    const poolMax =
      Number(
        process.env
          .DATABASE_POOL_MAX ??
          10,
      );

    const connectionTimeoutMillis =
      Number(
        process.env
          .DATABASE_CONNECTION_TIMEOUT_MS ??
          15000,
      );

    const idleTimeoutMillis =
      Number(
        process.env
          .DATABASE_IDLE_TIMEOUT_MS ??
          30000,
      );

    const adapter =
      new PrismaPg({
        connectionString,

        /*
         * Pool PostgreSQL.
         *
         * Se mantienen valores conservadores para no
         * sobredimensionar conexiones cuando el backend
         * tenga varias réplicas.
         *
         * Los valores pueden sobrescribirse por ambiente
         * mediante variables externas.
         */
        max:
          Number.isFinite(
            poolMax,
          ) &&
          poolMax > 0
            ? poolMax
            : 10,

        connectionTimeoutMillis:
          Number.isFinite(
            connectionTimeoutMillis,
          ) &&
          connectionTimeoutMillis > 0
            ? connectionTimeoutMillis
            : 15000,

        idleTimeoutMillis:
          Number.isFinite(
            idleTimeoutMillis,
          ) &&
          idleTimeoutMillis > 0
            ? idleTimeoutMillis
            : 30000,
      });

    super({
      adapter,
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
