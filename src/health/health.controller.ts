import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';

import { Public } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('live')
  live() {
    return {
      status: 'ok',
      service: 'infrastock-api',
    };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        status: 'ok',
        service: 'infrastock-api',
        database: 'ok',
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'infrastock-api',
        database: 'unavailable',
      });
    }
  }
}
