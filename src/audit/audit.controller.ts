import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';

import {
  Role,
} from '@prisma/client';

import type {
  Request,
} from 'express';

import {
  Roles,
} from '../auth/roles.decorator.js';

import type {
  JwtPayload,
} from '../auth/jwt-auth.guard.js';

import {
  AuditService,
  type AuditIntegrityStatus,
  type RevertPreviewResponse,
} from './audit.service.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

const AUDIT_HISTORY_ROLES:
  Readonly<
    Record<
      string,
      readonly Role[]
    >
  > = {
    SERVER: [
      Role.ADMIN,
      Role.EDITOR,
      Role.VIEWER,
    ],

    COMPANY: [
      Role.ADMIN,
    ],

    USER: [
      Role.ADMIN,
    ],

    CREDENTIAL: [
      Role.ADMIN,
    ],

    SERVER_SOFTWARE: [
      Role.ADMIN,
    ],

    NETWORK: [
      Role.ADMIN,
    ],

    IP_RESERVATION: [
      Role.ADMIN,
    ],

    OPERATING_SYSTEM: [
      Role.ADMIN,
      Role.EDITOR,
    ],

    SOFTWARE: [
      Role.ADMIN,
      Role.EDITOR,
    ],

    ECONOMIC_INDICATOR: [
      Role.ADMIN,
      Role.EDITOR,
    ],

    PRICING_TARIFF: [
      Role.ADMIN,
      Role.EDITOR,
    ],

    SERVER_IMPORT_BATCH: [
      Role.ADMIN,
      Role.EDITOR,
    ],
  };

@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditService:
      AuditService,
  ) {}


  @Get('integrity/status')
  @Roles(Role.ADMIN)
  getIntegrityStatus(): Promise<AuditIntegrityStatus> {
    return this.auditService.verifyIntegrity();
  }

  @Get(':id/revert-preview')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  getRevertPreview(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Req()
    request:
      AuthenticatedRequest,
  ): Promise<RevertPreviewResponse> {
    return this.auditService.getRevertPreview(
      id,
      request.user,
    );
  }

  @Post(':id/revert')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  revert(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.auditService.revert(
      id,
      request.user,
    );
  }

  @Get(
    ':entityType/:entityId',
  )
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findHistory(
    @Param(
      'entityType',
    )
    entityType:
      string,

    @Param(
      'entityId',
      ParseIntPipe,
    )
    entityId:
      number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    const normalizedEntityType =
      entityType
        .trim()
        .toUpperCase();

    if (
      !normalizedEntityType
    ) {
      throw new BadRequestException(
        'Tipo de entidad inválido',
      );
    }

    const allowedRoles =
      AUDIT_HISTORY_ROLES[
        normalizedEntityType
      ];

    if (
      !allowedRoles
    ) {
      throw new BadRequestException(
        'Tipo de entidad de auditoría no soportado',
      );
    }

    if (
      !allowedRoles.includes(
        request.user.role,
      )
    ) {
      throw new ForbiddenException(
        'No tienes permisos para consultar el historial de esta entidad',
      );
    }

    return this.auditService.findHistory(
      normalizedEntityType,
      entityId,
      request.user,
    );
  }
}
