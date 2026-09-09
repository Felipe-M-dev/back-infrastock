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
  Query,
  Req,
} from '@nestjs/common';

import { Role } from '@prisma/client';
import type { Request } from 'express';

import { Roles } from '../auth/roles.decorator.js';
import type { JwtPayload } from '../auth/jwt-auth.guard.js';

import { CreateIpReservationDto } from './dto/create-ip-reservation.dto.js';
import { CreateNetworkDto } from './dto/create-network.dto.js';
import { UpdateNetworkDto } from './dto/update-network.dto.js';
import {
  NetworksService,
  type IpInventoryStatus,
} from './networks.service.js';

interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

@Controller('networks')
export class NetworksController {
  constructor(
    private readonly networksService:
      NetworksService,
  ) {}

  @Get()
  @Roles(Role.ADMIN)
  findAll() {
    return this.networksService.findAll();
  }

  @Get(':id/ips')
  @Roles(Role.ADMIN)
  findIpInventory(
    @Param('id', ParseIntPipe)
    id: number,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    let parsedStatus:
      IpInventoryStatus | undefined;

    if (status) {
      if (
        !['FREE', 'USED', 'RESERVED'].includes(
          status,
        )
      ) {
        throw new BadRequestException(
          'Estado IP inválido',
        );
      }

      parsedStatus =
        status as IpInventoryStatus;
    }

    return this.networksService.findIpInventory(
      id,
      {
        search,
        status: parsedStatus,
        page: this.parsePositiveInteger(
          page,
          'Página inválida',
        ),
        pageSize: this.parsePositiveInteger(
          pageSize,
          'Tamaño de página inválido',
        ),
      },
    );
  }

  @Post()
  @Roles(Role.ADMIN)
  create(
    @Body() dto: CreateNetworkDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.networksService.create(
      dto,
      request.user,
    );
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(
    @Param('id', ParseIntPipe)
    id: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.networksService.remove(
      id,
      request.user,
    );
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  update(
    @Param('id', ParseIntPipe)
    id: number,
    @Body() dto: UpdateNetworkDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.networksService.update(
      id,
      dto,
      request.user,
    );
  }

  @Post(':id/reservations')
  @Roles(Role.ADMIN)
  createReservation(
    @Param('id', ParseIntPipe)
    id: number,
    @Body() dto: CreateIpReservationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.networksService.createReservation(
      id,
      dto,
      request.user,
    );
  }

  @Patch('reservations/:id/release')
  @Roles(Role.ADMIN)
  releaseReservation(
    @Param('id', ParseIntPipe)
    id: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.networksService.releaseReservation(
      id,
      request.user,
    );
  }

  @Patch(':id/ips/release-inactive')
  @Roles(Role.ADMIN)
  releaseInactiveServerIp(
    @Param('id', ParseIntPipe)
    id: number,
    @Req() request: AuthenticatedRequest,
    @Body('ipAddress') ipAddress?: string,
  ) {
    if (!ipAddress?.trim()) {
      throw new BadRequestException(
        'Debe indicar la IP',
      );
    }

    return this.networksService.releaseInactiveServerIp(
      id,
      ipAddress.trim(),
      request.user,
    );
  }

  private parsePositiveInteger(
    value: string | undefined,
    message: string,
  ): number | undefined {
    if (value === undefined || value === '') {
      return undefined;
    }

    const parsed = Number(value);

    if (
      !Number.isInteger(parsed) ||
      parsed <= 0
    ) {
      throw new BadRequestException(message);
    }

    return parsed;
  }
}
