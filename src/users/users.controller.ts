import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import type { JwtPayload } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import type { UploadedMediaFile } from '../media/media-storage.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UsersService } from './users.service.js';

interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

@Controller('users')
@Roles(Role.ADMIN)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
  ) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.usersService.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CreateUserDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usersService.create(
      dto,
      request.user,
    );
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usersService.update(
      id,
      dto,
      request.user,
    );
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usersService.remove(
      id,
      request.user,
    );
  }

  @Post(':id/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 5 * 1024 * 1024,
      },
    }),
  )
  uploadAvatar(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: UploadedMediaFile | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Debes seleccionar una imagen JPG, PNG o WebP',
      );
    }

    return this.usersService.updateAvatarByAdmin(
      id,
      file,
      request.user,
    );
  }

  @Delete(':id/avatar')
  removeAvatar(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usersService.removeAvatarByAdmin(
      id,
      request.user,
    );
  }
}
