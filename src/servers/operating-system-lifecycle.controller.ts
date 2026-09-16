import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
} from '@nestjs/common';

import { Role } from '@prisma/client';

import type {
  Request,
} from 'express';

import type {
  JwtPayload,
} from '../auth/jwt-auth.guard.js';

import {
  Roles,
} from '../auth/roles.decorator.js';

import {
  OperatingSystemLifecycleService,
} from './operating-system-lifecycle.service.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

@Controller('lifecycle')
export class OperatingSystemLifecycleController {
  constructor(
    private readonly lifecycleService:
      OperatingSystemLifecycleService,
  ) {}

  @Get('operating-systems')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  findOperatingSystems(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.lifecycleService.findInventory(
      request.user,
      {
        companyId:
          parsedCompanyId,
        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }

  private parseOptionalPositiveInteger(
    value: string | undefined,
    message: string,
  ) {
    if (
      value === undefined ||
      value.trim() === ''
    ) {
      return undefined;
    }

    const parsed =
      Number(value);

    if (
      !Number.isInteger(
        parsed,
      ) ||
      parsed <= 0
    ) {
      throw new BadRequestException(
        message,
      );
    }

    return parsed;
  }
}
