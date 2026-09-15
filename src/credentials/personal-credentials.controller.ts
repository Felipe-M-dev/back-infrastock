import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import type { JwtPayload } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import {
  CreatePersonalCredentialDto,
  PersonalCredentialQueryDto,
  UpdatePersonalCredentialDto,
} from './dto/personal-credential.dto.js';
import { PersonalCredentialsService } from './personal-credentials.service.js';

interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

@Controller('personal-credentials')
@Roles(Role.ADMIN, Role.EDITOR, Role.VIEWER)
export class PersonalCredentialsController {
  constructor(private readonly service: PersonalCredentialsService) {}

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query() query: PersonalCredentialQueryDto,
  ) {
    return this.service.list(req.user, query);
  }

  @Get('users/:userId')
  @Roles(Role.ADMIN)
  listForUser(
    @Req() req: AuthenticatedRequest,
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: PersonalCredentialQueryDto,
  ) {
    return this.service.list(req.user, query, userId);
  }

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreatePersonalCredentialDto,
  ) {
    return this.service.create(req.user, dto);
  }

  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePersonalCredentialDto,
  ) {
    return this.service.update(req.user, id, dto);
  }

  @Delete(':id')
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.remove(req.user, id);
  }

  @Post(':id/copy-password')
  @HttpCode(200)
  copy(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.copyPassword(req.user, id);
  }

  @Post('users/:userId/:id/copy-password')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  copyForUser(
    @Req() req: AuthenticatedRequest,
    @Param('userId', ParseIntPipe) userId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.copyPassword(req.user, id, userId);
  }
}
