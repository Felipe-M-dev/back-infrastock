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

import { OperatingSystemsService } from './operating-systems.service.js';
import { CreateOperatingSystemDto } from './dto/create-operating-system.dto.js';
import { UpdateOperatingSystemDto } from './dto/update-operating-system.dto.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

@Controller('operating-systems')
export class OperatingSystemsController {
  constructor(
    private readonly operatingSystemsService:
      OperatingSystemsService,
  ) {}

  @Get()
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  findAll() {
    return this.operatingSystemsService.findAll();
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
    return this.operatingSystemsService.findOne(
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
    dto: CreateOperatingSystemDto,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.operatingSystemsService.create(
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
    dto: UpdateOperatingSystemDto,

    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.operatingSystemsService.update(
      id,
      dto,
      request.user,
    );
  }
}
