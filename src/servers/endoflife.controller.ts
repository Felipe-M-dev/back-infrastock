import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';

import {
  Role,
} from '@prisma/client';

import type {
  Request,
} from 'express';

import type {
  JwtPayload,
} from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { UpdateEndOfLifeMappingDto } from './dto/update-endoflife-mapping.dto.js';
import { EndOfLifeService } from './endoflife.service.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

@Controller('endoflife')
@Roles(
  Role.ADMIN,
  Role.EDITOR,
)
export class EndOfLifeController {
  constructor(
    private readonly endOfLifeService:
      EndOfLifeService,
  ) {}

  @Get('products')
  products(
    @Query('refresh')
    refresh = '',
  ) {
    return this.endOfLifeService.getCatalogResponse(
      refresh === 'true' ||
        refresh === '1',
    );
  }

  @Get('resolve')
  resolve(
    @Query('name')
    name = '',
  ) {
    return this.endOfLifeService.resolveProductReference(
      name,
    );
  }

  @Get('mappings')
  mappings() {
    return this.endOfLifeService.getMappings();
  }

  @Patch('mappings/software/:id')
  updateSoftwareMapping(
    @Param('id', ParseIntPipe)
    id: number,

    @Body()
    dto: UpdateEndOfLifeMappingDto,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.endOfLifeService.updateMapping(
      'SOFTWARE',
      id,
      dto.productKey,
      request.user,
    );
  }

  @Patch('mappings/operating-system/:id')
  updateOperatingSystemMapping(
    @Param('id', ParseIntPipe)
    id: number,

    @Body()
    dto: UpdateEndOfLifeMappingDto,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.endOfLifeService.updateMapping(
      'OPERATING_SYSTEM',
      id,
      dto.productKey,
      request.user,
    );
  }
}
