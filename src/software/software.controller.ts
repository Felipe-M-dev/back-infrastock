import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';

import { Role } from '@prisma/client';
import type { Request } from 'express';

import { Roles } from '../auth/roles.decorator.js';
import type { JwtPayload } from '../auth/jwt-auth.guard.js';

import { SoftwareService } from './software.service.js';
import { CreateSoftwareDto } from './dto/create-software.dto.js';
import { UpdateSoftwareDto } from './dto/update-software.dto.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

@Controller('software')
export class SoftwareController {
  constructor(
    private readonly softwareService:
      SoftwareService,
  ) {}

  @Get()
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  findAll() {
    return this.softwareService.findAll();
  }

  @Get(':id')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  findOne(
    @Param('id', ParseIntPipe)
    id: number,
  ) {
    return this.softwareService.findOne(
      id,
    );
  }

  @Post()
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  create(
    @Body()
    dto: CreateSoftwareDto,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.softwareService.create(
      dto,
      request.user,
    );
  }

  @Patch(':id')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  update(
    @Param('id', ParseIntPipe)
    id: number,

    @Body()
    dto: UpdateSoftwareDto,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.softwareService.update(
      id,
      dto,
      request.user,
    );
  }
}
