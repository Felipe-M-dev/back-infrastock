import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import type { Request } from 'express';

import type { UploadedMediaFile } from '../media/media-storage.service.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { Public } from './public.decorator.js';
import type { JwtPayload } from './jwt-auth.guard.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService:
      AuthService,
  ) {}

  @Public()
  @Post('login')
  login(
    @Body() loginDto: LoginDto,
    @Req() request: Request,
  ) {
    return this.authService.login(
      loginDto,
      request.ip ||
        request.socket.remoteAddress ||
        'unknown',
    );
  }

  @Get('me')
  me(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return request.user;
  }

  @Get('profile')
  profile(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.authService.getProfile(
      request.user.sub,
    );
  }

  @Patch('profile')
  updateProfile(
    @Req()
    request: AuthenticatedRequest,

    @Body()
    updateProfileDto:
      UpdateProfileDto,
  ) {
    return this.authService.updateProfile(
      request.user.sub,
      updateProfileDto,
    );
  }

  @Post('profile/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 5 * 1024 * 1024,
      },
    }),
  )
  updateAvatar(
    @Req()
    request: AuthenticatedRequest,

    @UploadedFile()
    file: UploadedMediaFile | undefined,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Debes seleccionar una imagen',
      );
    }

    return this.authService.updateAvatar(
      request.user.sub,
      file,
    );
  }

  @Delete('profile/avatar')
  removeAvatar(
    @Req()
    request: AuthenticatedRequest,
  ) {
    return this.authService.removeAvatar(
      request.user.sub,
    );
  }
}
