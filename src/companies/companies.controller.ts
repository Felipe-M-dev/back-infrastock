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
import { CompaniesService } from './companies.service.js';
import { CreateCompanyDto } from './dto/create-company.dto.js';
import { UpdateCompanyDto } from './dto/update-company.dto.js';

interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

@Controller('companies')
@Roles(Role.ADMIN)
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
  ) {}

  @Get()
  findAll() {
    return this.companiesService.findAll();
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.companiesService.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CreateCompanyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.companiesService.create(
      dto,
      request.user,
    );
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCompanyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.companiesService.update(
      id,
      dto,
      request.user,
    );
  }

  @Post(':id/logo')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 2 * 1024 * 1024,
      },
    }),
  )
  uploadLogo(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: UploadedMediaFile | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!file) {
      throw new BadRequestException(
        'Debes seleccionar un logo PNG o SVG',
      );
    }

    return this.companiesService.uploadLogo(
      id,
      file,
      request.user,
    );
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.companiesService.remove(
      id,
      request.user,
    );
  }

  @Delete(':id/logo')
  removeLogo(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.companiesService.removeLogo(
      id,
      request.user,
    );
  }
}
