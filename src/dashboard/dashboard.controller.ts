import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
} from '@nestjs/common';

import { Role } from '@prisma/client';
import type { Request } from 'express';

import { Roles } from '../auth/roles.decorator.js';
import type { JwtPayload } from '../auth/jwt-auth.guard.js';

import { DashboardService } from './dashboard.service.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService:
      DashboardService,
  ) {}

  @Get('summary')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  getSummary(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('environment')
    environment?: string,

    @Query('companyId')
    companyId?: string,
  ) {
    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(
        environment,
      )
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    let parsedCompanyId:
      | number
      | undefined;

    if (
      companyId !== undefined &&
      companyId !== ''
    ) {
      parsedCompanyId =
        Number(
          companyId,
        );

      if (
        !Number.isInteger(
          parsedCompanyId,
        ) ||
        parsedCompanyId <= 0
      ) {
        throw new BadRequestException(
          'Empresa inválida',
        );
      }
    }

    return this.dashboardService.getSummary(
      request.user,

      environment as
        | 'PRD'
        | 'QAS'
        | 'DEV'
        | undefined,

      parsedCompanyId,
    );
  }
}