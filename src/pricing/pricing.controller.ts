import {
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
import type { JwtPayload } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CreatePricingTariffDto } from './dto/create-pricing-tariff.dto.js';
import { ManualUfDto } from './dto/manual-uf.dto.js';
import { UpdatePricingTariffDto } from './dto/update-pricing-tariff.dto.js';
import { PricingService } from './pricing.service.js';

interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

@Controller('pricing')
export class PricingController {
  constructor(
    private readonly pricingService: PricingService,
  ) {}

  @Get('summary')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  getSummary() {
    return this.pricingService.getSummary();
  }

  @Get('uf')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  getUf() {
    return this.pricingService.getLatestUf();
  }

  @Post('uf/refresh')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  refreshUf(
    @Req() request: AuthenticatedRequest,
  ) {
    return this.pricingService.refreshUf(
      request.user,
    );
  }

  @Post('uf/manual')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  setManualUf(
    @Body() dto: ManualUfDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.pricingService.setManualUf(
      dto,
      request.user,
    );
  }

  @Get('server-valuations')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  getServerValuations(
    @Req() request: AuthenticatedRequest,
    @Query('companyId') companyId?: string,
    @Query('environment') environment?: string,
  ) {
    return this.pricingService.getServerValuations(
      request.user,
      companyId,
      environment,
    );
  }

  @Get('server-valuations/:id')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  getServerValuation(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.pricingService.getServerValuation(
      request.user,
      id,
    );
  }

  @Get('tariffs')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  getTariffs() {
    return this.pricingService.getTariffs();
  }

  @Post('tariffs')
  @Roles(
    Role.ADMIN,
  )
  createTariff(
    @Body() dto: CreatePricingTariffDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.pricingService.createTariff(
      dto,
      request.user,
    );
  }

  @Patch('tariffs/:id')
  @Roles(
    Role.ADMIN,
  )
  updateTariff(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePricingTariffDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.pricingService.updateTariff(
      id,
      dto,
      request.user,
    );
  }

  @Delete('tariffs/:id')
  @Roles(
    Role.ADMIN,
  )
  deleteTariff(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.pricingService.deleteTariff(
      id,
      request.user,
    );
  }
}
