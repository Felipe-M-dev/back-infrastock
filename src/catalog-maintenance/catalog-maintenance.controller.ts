import {
  Controller,
  Delete,
  Param,
  ParseIntPipe,
  Req,
} from '@nestjs/common';

import { Role } from '@prisma/client';
import type { Request } from 'express';

import type { JwtPayload } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';

import { CatalogMaintenanceService } from './catalog-maintenance.service.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

@Controller('catalog-maintenance')
export class CatalogMaintenanceController {
  constructor(
    private readonly catalogMaintenanceService:
      CatalogMaintenanceService,
  ) {}

  @Delete('software/:id')
  @Roles(Role.ADMIN)
  deleteSoftware(
    @Param('id', ParseIntPipe)
    id: number,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.catalogMaintenanceService.deleteSoftware(
      id,
      request.user,
    );
  }

  @Delete('operating-systems/:id')
  @Roles(Role.ADMIN)
  deleteOperatingSystem(
    @Param('id', ParseIntPipe)
    id: number,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.catalogMaintenanceService.deleteOperatingSystem(
      id,
      request.user,
    );
  }
}
