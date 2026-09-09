import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';

import { Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';

import type { JwtPayload } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { ServerImportsService } from './server-imports.service.js';
import { ConfirmServerImportDto } from './dto/confirm-server-import.dto.js';

interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

interface UploadedImportFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller('server-imports')
export class ServerImportsController {
  constructor(
    private readonly serverImportsService: ServerImportsService,
  ) {}

  @Get('template.xlsx')
  @Roles(Role.ADMIN, Role.EDITOR)
  async downloadTemplate(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const buffer = await this.serverImportsService.buildTemplate(
      request.user,
    );
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', 'attachment; filename="infrastock-plantilla-carga-servidores.xlsx"');
    return new StreamableFile(buffer);
  }

  @Get()
  @Roles(Role.ADMIN, Role.EDITOR)
  getHistory(
    @Req() request: AuthenticatedRequest,
  ) {
    return this.serverImportsService.getHistory(request.user);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.EDITOR)
  getBatch(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.serverImportsService.getBatch(id, request.user);
  }

  @Post('preview')
  @Roles(Role.ADMIN, Role.EDITOR)
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: 5 * 1024 * 1024,
    },
  }))
  preview(
    @UploadedFile() file: UploadedImportFile | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!file) {
      throw new BadRequestException('Debe adjuntar un archivo CSV o XLSX');
    }

    return this.serverImportsService.preview(file, request.user);
  }

  @Post(':id/confirm')
  @Roles(Role.ADMIN, Role.EDITOR)
  confirm(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthenticatedRequest,
    @Body() body: ConfirmServerImportDto,
  ) {
    return this.serverImportsService.confirm(id, body.decisions ?? [], request.user);
  }
}
