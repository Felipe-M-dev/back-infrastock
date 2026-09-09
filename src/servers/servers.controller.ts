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
  Res,
  StreamableFile,
} from '@nestjs/common';

import { Role } from '@prisma/client';

import type {
  Request,
  Response,
} from 'express';

import { Roles } from '../auth/roles.decorator.js';
import type { JwtPayload } from '../auth/jwt-auth.guard.js';

import { CreateServerDto } from './dto/create-server.dto.js';
import { UpdateServerDto } from './dto/update-server.dto.js';

import {
  DEFAULT_SERVER_EXPORT_FIELDS,
  SERVER_EXPORT_FIELDS,
  type ServerExportField,
} from './server-export-fields.js';

import { ServersCatalogService } from './servers-catalog.service.js';

import {
  ServersService,
  type ServerFilters,
  type ServerInventoryIssue,
  type ServerInventoryFreshness,
  type ServerInventoryConfidence,
  type ServerQualityIssueCount,
  type ServerSoftwareSupportStatus,
  type ServerSortBy,
  type ServerSortOrder,
} from './servers.service.js';

interface AuthenticatedRequest
  extends Request {
  user: JwtPayload;
}

const VALID_INVENTORY_ISSUES:
  ServerInventoryIssue[] = [
    'missingIp',
    'missingOperatingSystem',
    'incompleteResources',
    'missingSoftware',
  ];

const VALID_QUALITY_ISSUE_COUNTS:
  ServerQualityIssueCount[] = [
    '0',
    '1',
    '2',
    '3plus',
  ];

const VALID_SOFTWARE_SUPPORT_STATUSES:
  ServerSoftwareSupportStatus[] = [
    'EOL',
    'EOL_SOON',
  ];

const VALID_INVENTORY_FRESHNESS:
  ServerInventoryFreshness[] = [
    'recent',
    'days30to59',
    'days60to89',
    'days90plus',
  ];

const VALID_INVENTORY_CONFIDENCE:
  ServerInventoryConfidence[] = [
    'HIGH',
    'MEDIUM',
    'LOW',
  ];

const VALID_SORT_FIELDS:
  ServerSortBy[] = [
    'hostname',
    'company',
    'ipAddress',
    'environment',
    'operatingSystem',
    'cpuCores',
    'ramGb',
    'diskGb',
    'updatedAt',
  ];

@Controller('servers')
export class ServersController {
  constructor(
    private readonly serversService:
      ServersService,

    private readonly serversCatalogService:
      ServersCatalogService,
  ) {}

  @Get()
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findAll(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('search')
    search?: string,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,

    @Query('operatingSystemId')
    operatingSystemId?: string,

    @Query('softwareId')
    softwareId?: string,

    @Query('softwareVersion')
    softwareVersion?: string,

    @Query('inventoryIssue')
    inventoryIssue?: string,

    @Query('qualityIssueCount')
    qualityIssueCount?: string,

    @Query('softwareSupportStatus')
    softwareSupportStatus?: string,

    @Query('inventoryFreshness')
    inventoryFreshness?: string,

    @Query('inventoryConfidence')
    inventoryConfidence?: string,

    @Query('active')
    active?: string,

    @Query('page')
    page?: string,

    @Query('pageSize')
    pageSize?: string,

    @Query('sortBy')
    sortBy?: string,

    @Query('sortOrder')
    sortOrder?: string,
  ) {
    const filters =
      this.buildFilters({
        search,
        companyId,
        environment,
        operatingSystemId,
        softwareId,
        softwareVersion,
        inventoryIssue,
        qualityIssueCount,
        softwareSupportStatus,
        inventoryFreshness,
        inventoryConfidence,
        active,
        page,
        pageSize,
        sortBy,
        sortOrder,
        includePagination:
          true,
      });

    return this.serversService.findAll(
      request.user,
      filters,
    );
  }

  @Get('accessible-companies')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findAccessibleCompanies(
    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.serversService.findAccessibleCompanies(
      request.user,
    );
  }

  @Get('catalogs')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findCatalogs() {
    return this.serversCatalogService.findAll();
  }

  @Get('software-versions')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findSoftwareVersions(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('softwareId')
    softwareId?: string,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedSoftwareId =
      this.parseOptionalPositiveInteger(
        softwareId,
        'Software inválido',
      );

    if (
      parsedSoftwareId ===
      undefined
    ) {
      throw new BadRequestException(
        'Debe indicar un software válido',
      );
    }

    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.serversCatalogService.findSoftwareVersions(
      request.user,
      {
        softwareId:
          parsedSoftwareId,

        companyId:
          parsedCompanyId,

        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }

  @Get('software-version-inventory')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  findSoftwareVersionInventory(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.serversCatalogService.findSoftwareVersionInventory(
      request.user,
      {
        companyId:
          parsedCompanyId,

        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }

  @Get('software-support-summary')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findSoftwareSupportSummary(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.serversCatalogService.findSoftwareSupportSummary(
      request.user,
      {
        companyId:
          parsedCompanyId,

        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }


  @Get('inventory-freshness-summary')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findInventoryFreshnessSummary(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.serversCatalogService.findInventoryFreshnessSummary(
      request.user,
      {
        companyId:
          parsedCompanyId,
        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }


  @Get('inventory-confidence-summary')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findInventoryConfidenceSummary(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.serversCatalogService.findInventoryConfidenceSummary(
      request.user,
      {
        companyId:
          parsedCompanyId,

        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }


  @Get('inventory-review-priorities')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  findInventoryReviewPriorities(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.serversCatalogService.findInventoryReviewPriorities(
      request.user,
      {
        companyId:
          parsedCompanyId,

        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }


  @Get('technology-risk')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findTechnologyRisk(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.serversCatalogService.findTechnologyRisk(
      request.user,
      {
        companyId:
          parsedCompanyId,
        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }


  @Get('software-update-priorities')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findSoftwareUpdatePriorities(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,
  ) {
    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        companyId,
        'Empresa inválida',
      );

    if (
      environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(environment)
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    return this.serversCatalogService.findSoftwareUpdatePriorities(
      request.user,
      {
        companyId:
          parsedCompanyId,

        environment:
          environment as
            | 'PRD'
            | 'QAS'
            | 'DEV'
            | undefined,
      },
    );
  }

  @Get('export/csv')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  async exportCsv(
    @Req()
    request:
      AuthenticatedRequest,

    @Res({
      passthrough:
        true,
    })
    response:
      Response,

    @Query('search')
    search?: string,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,

    @Query('operatingSystemId')
    operatingSystemId?: string,

    @Query('softwareId')
    softwareId?: string,

    @Query('softwareVersion')
    softwareVersion?: string,

    @Query('inventoryIssue')
    inventoryIssue?: string,

    @Query('qualityIssueCount')
    qualityIssueCount?: string,

    @Query('softwareSupportStatus')
    softwareSupportStatus?: string,

    @Query('inventoryFreshness')
    inventoryFreshness?: string,

    @Query('inventoryConfidence')
    inventoryConfidence?: string,

    @Query('active')
    active?: string,

    @Query('sortBy')
    sortBy?: string,

    @Query('sortOrder')
    sortOrder?: string,

    @Query('fields')
    fields?: string,
  ) {
    const filters =
      this.buildFilters({
        search,
        companyId,
        environment,
        operatingSystemId,
        softwareId,
        softwareVersion,
        inventoryIssue,
        qualityIssueCount,
        softwareSupportStatus,
        inventoryFreshness,
        inventoryConfidence,
        active,
        sortBy,
        sortOrder,
        fields,
        includePagination:
          false,
      });

    const csv =
      await this.serversService.exportCsv(
        request.user,
        filters,
      );

    const filename =
      this.buildFilename(
        'csv',
      );

    response.setHeader(
      'Content-Type',
      'text/csv; charset=utf-8',
    );

    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );

    response.setHeader(
      'Cache-Control',
      'no-store',
    );

    return csv;
  }

  @Get('export/xlsx')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  async exportXlsx(
    @Req()
    request:
      AuthenticatedRequest,

    @Query('search')
    search?: string,

    @Query('companyId')
    companyId?: string,

    @Query('environment')
    environment?: string,

    @Query('operatingSystemId')
    operatingSystemId?: string,

    @Query('softwareId')
    softwareId?: string,

    @Query('softwareVersion')
    softwareVersion?: string,

    @Query('inventoryIssue')
    inventoryIssue?: string,

    @Query('qualityIssueCount')
    qualityIssueCount?: string,

    @Query('softwareSupportStatus')
    softwareSupportStatus?: string,

    @Query('inventoryFreshness')
    inventoryFreshness?: string,

    @Query('inventoryConfidence')
    inventoryConfidence?: string,

    @Query('active')
    active?: string,

    @Query('sortBy')
    sortBy?: string,

    @Query('sortOrder')
    sortOrder?: string,

    @Query('fields')
    fields?: string,
  ): Promise<StreamableFile> {
    const filters =
      this.buildFilters({
        search,
        companyId,
        environment,
        operatingSystemId,
        softwareId,
        softwareVersion,
        inventoryIssue,
        qualityIssueCount,
        softwareSupportStatus,
        inventoryFreshness,
        inventoryConfidence,
        active,
        sortBy,
        sortOrder,
        fields,
        includePagination:
          false,
      });

    const xlsx =
      await this.serversService.exportXlsx(
        request.user,
        filters,
      );

    const filename =
      this.buildFilename(
        'xlsx',
      );

    return new StreamableFile(
      xlsx,
      {
        type:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

        disposition:
          `attachment; filename="${filename}"`,

        length:
          xlsx.length,
      },
    );
  }

  @Get(':id')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
    Role.VIEWER,
  )
  findOne(
    @Param(
      'id',
      ParseIntPipe,
    )
    id:
      number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.serversService.findOne(
      id,
      request.user,
    );
  }

  @Post()
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  create(
    @Body()
    dto:
      CreateServerDto,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.serversService.create(
      dto,
      request.user,
    );
  }

  @Patch(':id/activate')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  activate(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.serversService.activate(
      id,
      request.user,
    );
  }

  @Patch(':id/deactivate')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  deactivate(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.serversService.deactivate(
      id,
      request.user,
    );
  }

  @Patch(':id')
  @Roles(
    Role.ADMIN,
    Role.EDITOR,
  )
  update(
    @Param(
      'id',
      ParseIntPipe,
    )
    id:
      number,

    @Body()
    dto:
      UpdateServerDto,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.serversService.update(
      id,
      dto,
      request.user,
    );
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(
    @Param(
      'id',
      ParseIntPipe,
    )
    id:
      number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.serversService.remove(
      id,
      request.user,
    );
  }

  private buildFilters(
    input: {
      search?: string;
      companyId?: string;
      environment?: string;
      operatingSystemId?: string;
      softwareId?: string;
      softwareVersion?: string;
      inventoryIssue?: string;
      qualityIssueCount?: string;
      softwareSupportStatus?: string;
      inventoryFreshness?: string;
      inventoryConfidence?: string;
      active?: string;
      page?: string;
      pageSize?: string;
      sortBy?: string;
      sortOrder?: string;
      fields?: string;
      includePagination:
        boolean;
    },
  ): ServerFilters {
    if (
      input.environment &&
      ![
        'PRD',
        'QAS',
        'DEV',
      ].includes(
        input.environment,
      )
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    if (
      input.inventoryIssue &&
      !VALID_INVENTORY_ISSUES.includes(
        input.inventoryIssue as
          ServerInventoryIssue,
      )
    ) {
      throw new BadRequestException(
        'Filtro de calidad de inventario inválido',
      );
    }

    if (
      input.qualityIssueCount &&
      !VALID_QUALITY_ISSUE_COUNTS.includes(
        input.qualityIssueCount as
          ServerQualityIssueCount,
      )
    ) {
      throw new BadRequestException(
        'Cantidad de problemas de calidad inválida',
      );
    }

    if (
      input.softwareSupportStatus &&
      !VALID_SOFTWARE_SUPPORT_STATUSES.includes(
        input.softwareSupportStatus as
          ServerSoftwareSupportStatus,
      )
    ) {
      throw new BadRequestException(
        'Estado de soporte de software inválido',
      );
    }

    if (
      input.inventoryFreshness &&
      !VALID_INVENTORY_FRESHNESS.includes(
        input.inventoryFreshness as
          ServerInventoryFreshness,
      )
    ) {
      throw new BadRequestException(
        'Antigüedad del inventario inválida',
      );
    }

    if (
      input.inventoryConfidence &&
      !VALID_INVENTORY_CONFIDENCE.includes(
        input.inventoryConfidence as
          ServerInventoryConfidence,
      )
    ) {
      throw new BadRequestException(
        'Confiabilidad del inventario inválida',
      );
    }

    if (
      input.active !==
        undefined &&
      input.active !==
        '' &&
      input.active !==
        'true' &&
      input.active !==
        'false'
    ) {
      throw new BadRequestException(
        'Estado inválido',
      );
    }

    if (
      input.sortBy &&
      !VALID_SORT_FIELDS.includes(
        input.sortBy as
          ServerSortBy,
      )
    ) {
      throw new BadRequestException(
        'Campo de ordenamiento inválido',
      );
    }

    if (
      input.sortOrder &&
      input.sortOrder !==
        'asc' &&
      input.sortOrder !==
        'desc'
    ) {
      throw new BadRequestException(
        'Dirección de ordenamiento inválida',
      );
    }

    const parsedCompanyId =
      this.parseOptionalPositiveInteger(
        input.companyId,
        'Empresa inválida',
      );

    const parsedOperatingSystemId =
      this.parseOptionalPositiveInteger(
        input.operatingSystemId,
        'Sistema operativo inválido',
      );

    const parsedSoftwareId =
      this.parseOptionalPositiveInteger(
        input.softwareId,
        'Software inválido',
      );

    const parsedFields =
      this.parseExportFields(
        input.fields,
      );

    let parsedPage:
      number | undefined;

    let parsedPageSize:
      number | undefined;

    if (
      input.includePagination
    ) {
      parsedPage =
        this.parseOptionalPositiveInteger(
          input.page,
          'Página inválida',
        ) ??
        1;

      parsedPageSize =
        this.parseOptionalPositiveInteger(
          input.pageSize,
          'Tamaño de página inválido',
        ) ??
        10;

      if (
        ![
          10,
          25,
          50,
          100,
        ].includes(
          parsedPageSize,
        )
      ) {
        throw new BadRequestException(
          'El tamaño de página debe ser 10, 25, 50 o 100',
        );
      }
    }

    return {
      search:
        input.search?.trim() ||
        undefined,

      companyId:
        parsedCompanyId,

      environment:
        input.environment as
          | 'PRD'
          | 'QAS'
          | 'DEV'
          | undefined,

      operatingSystemId:
        parsedOperatingSystemId,

      softwareId:
        parsedSoftwareId,

      softwareVersion:
        input.softwareVersion?.trim() ||
        undefined,

      inventoryIssue:
        input.inventoryIssue as
          | ServerInventoryIssue
          | undefined,

      qualityIssueCount:
        input.qualityIssueCount as
          | ServerQualityIssueCount
          | undefined,

      softwareSupportStatus:
        input.softwareSupportStatus as
          | ServerSoftwareSupportStatus
          | undefined,

      inventoryFreshness:
        input.inventoryFreshness as
          | ServerInventoryFreshness
          | undefined,

      inventoryConfidence:
        input.inventoryConfidence as
          | ServerInventoryConfidence
          | undefined,

      active:
        input.active ===
          '' ||
        input.active ===
          undefined
          ? undefined
          : input.active ===
            'true',

      page:
        parsedPage,

      pageSize:
        parsedPageSize,

      sortBy:
        (
          input.sortBy as
            | ServerSortBy
            | undefined
        ) ??
        'hostname',

      sortOrder:
        (
          input.sortOrder as
            | ServerSortOrder
            | undefined
        ) ??
        'asc',

      fields:
        parsedFields,
    };
  }

  private parseOptionalPositiveInteger(
    value:
      | string
      | undefined,

    message:
      string,
  ):
    | number
    | undefined {
    if (
      value ===
        undefined ||
      value ===
        ''
    ) {
      return undefined;
    }

    const parsed =
      Number(
        value,
      );

    if (
      !Number.isInteger(
        parsed,
      ) ||
      parsed <=
        0
    ) {
      throw new BadRequestException(
        message,
      );
    }

    return parsed;
  }

  private parseExportFields(
    value:
      | string
      | undefined,
  ): ServerExportField[] {
    if (
      value ===
        undefined ||
      value.trim() ===
        ''
    ) {
      return [
        ...DEFAULT_SERVER_EXPORT_FIELDS,
      ];
    }

    const requestedFields =
      value
        .split(',')
        .map(
          (item) =>
            item.trim(),
        )
        .filter(
          Boolean,
        );

    if (
      requestedFields.length ===
      0
    ) {
      throw new BadRequestException(
        'Debe seleccionar al menos un campo para exportar',
      );
    }

    const invalidFields =
      requestedFields.filter(
        (field) =>
          !SERVER_EXPORT_FIELDS.includes(
            field as ServerExportField,
          ),
      );

    if (
      invalidFields.length >
      0
    ) {
      throw new BadRequestException(
        `Campos de exportación inválidos: ${invalidFields.join(', ')}`,
      );
    }

    const uniqueFields =
      Array.from(
        new Set(
          requestedFields,
        ),
      );

    return uniqueFields as
      ServerExportField[];
  }

  private buildFilename(
    extension:
      'csv'
      | 'xlsx',
  ) {
    const date =
      new Date()
        .toISOString()
        .slice(
          0,
          10,
        );

    return `infrastock-servidores-${date}.${extension}`;
  }
}
