import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  Prisma,
  Role,
} from '@prisma/client';

import {
  isIP,
} from 'node:net';

import ExcelJS from 'exceljs';

import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isUsableIpv4InCidr } from '../networks/ipv4-cidr.js';
import {
  assertActiveCompanyAccessible,
  assertCompanyAccessible,
  buildScopedServerCompanyWhere,
  getAccessibleCompanies,
} from '../company-scope/company-scope.js';

import { CreateServerDto } from './dto/create-server.dto.js';
import { EndOfLifeService } from './endoflife.service.js';
import {
  calculateInventoryConfidence,
  type ServerInventoryConfidence,
} from './inventory-confidence.js';
import { UpdateServerDto } from './dto/update-server.dto.js';

import {
  DEFAULT_SERVER_EXPORT_FIELDS,
  type ServerExportField,
} from './server-export-fields.js';

interface CurrentUser {
  sub: number;
  username: string;
  role: Role;
  companyId: number | null;
}

interface AuditChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
  beforeValue: unknown;
  afterValue: unknown;
}

interface ServerUpdateInternalOptions {
  targetActive?: boolean;
}

interface ServerIdRow {
  id: number;
}

interface ExportColumnDefinition {
  header: string;
  key: string;
  width: number;
}

export type ServerSortBy =
  | 'hostname'
  | 'company'
  | 'ipAddress'
  | 'environment'
  | 'operatingSystem'
  | 'cpuCores'
  | 'ramGb'
  | 'diskGb'
  | 'updatedAt';

export type ServerSortOrder =
  | 'asc'
  | 'desc';

export type ServerInventoryIssue =
  | 'missingIp'
  | 'missingOperatingSystem'
  | 'incompleteResources'
  | 'missingSoftware';

export type ServerQualityIssueCount =
  | '0'
  | '1'
  | '2'
  | '3plus';

export type ServerSoftwareSupportStatus =
  | 'EOL'
  | 'EOL_SOON';

export type ServerInventoryFreshness =
  | 'recent'
  | 'days30to59'
  | 'days60to89'
  | 'days90plus';

export type {
  ServerInventoryConfidence,
} from './inventory-confidence.js';

export interface ServerFilters {
  search?: string;

  companyId?: number;

  environment?:
    | 'PRD'
    | 'QAS'
    | 'DEV';

  operatingSystemId?: number;

  softwareId?: number;

  softwareVersion?: string;

  inventoryIssue?:
    ServerInventoryIssue;

  qualityIssueCount?:
    ServerQualityIssueCount;

  softwareSupportStatus?:
    ServerSoftwareSupportStatus;

  inventoryFreshness?:
    ServerInventoryFreshness;

  inventoryConfidence?:
    ServerInventoryConfidence;

  active?: boolean;

  page?: number;

  pageSize?: number;

  sortBy?: ServerSortBy;

  sortOrder?: ServerSortOrder;

  fields?:
    ServerExportField[];
}

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly endOfLifeService: EndOfLifeService,
  ) {}

  async findAll(
    currentUser: CurrentUser,
    filters: ServerFilters = {},
  ) {
    const page =
      filters.page ?? 1;

    const pageSize =
      filters.pageSize ?? 10;

    const sortBy =
      filters.sortBy ??
      'hostname';

    const sortOrder =
      filters.sortOrder ??
      'asc';

    const securityWhere =
      await this.buildSecurityWhere(
        currentUser,
      );

    const where =
      await this.buildWhere(
        currentUser,
        filters,
      );

    const [
      total,
      filtered,
    ] = await Promise.all([
      this.prisma.server.count({
        where:
          securityWhere,
      }),

      this.prisma.server.count({
        where,
      }),
    ]);

    const totalPages =
      Math.max(
        1,
        Math.ceil(
          filtered /
            pageSize,
        ),
      );

    const effectivePage =
      Math.min(
        page,
        totalPages,
      );

    const skip =
      (
        effectivePage -
        1
      ) *
      pageSize;

    const orderBy =
      this.buildOrderBy(
        sortBy,
        sortOrder,
      );

    const items =
      await this.prisma.server.findMany({
        where,

        skip,

        take:
          pageSize,

        include:
          this.getServerInclude(),

        orderBy,
      });

    return {
      items,

      total,

      filtered,

      page:
        effectivePage,

      pageSize,

      totalPages,

      sortBy,

      sortOrder,
    };
  }

  async exportCsv(
    currentUser: CurrentUser,
    filters: ServerFilters = {},
  ) {
    const servers =
      await this.getServersForExport(
        currentUser,
        filters,
      );

    const selectedFields =
      this.getSelectedExportFields(
        filters,
      );

    const headersByField =
      this.getExportHeaders();

    const headers =
      selectedFields.map(
        (field) =>
          headersByField[
            field
          ],
      );

    const rows =
      servers.map(
        (server) => {
          const valuesByField =
            this.getExportValues(
              server,
              true,
            );

          return selectedFields.map(
            (field) =>
              valuesByField[
                field
              ],
          );
        },
      );

    const content = [
      headers,
      ...rows,
    ]
      .map(
        (row) =>
          row
            .map(
              (value) =>
                this.escapeCsvValue(
                  value,
                ),
            )
            .join(';'),
      )
      .join('\r\n');

    return `\uFEFF${content}`;
  }

  async exportXlsx(
    currentUser: CurrentUser,
    filters: ServerFilters = {},
  ): Promise<Buffer> {
    const servers =
      await this.getServersForExport(
        currentUser,
        filters,
      );

    const selectedFields =
      this.getSelectedExportFields(
        filters,
      );

    const columnDefinitions =
      this.getExportColumnDefinitions();

    const workbook =
      new ExcelJS.Workbook();

    workbook.creator =
      'InfraStock';

    workbook.company =
      'InfraStock';

    workbook.created =
      new Date();

    workbook.modified =
      new Date();

    const inventorySheet =
      workbook.addWorksheet(
        'Inventario',
        {
          views: [
            {
              state:
                'frozen',

              ySplit:
                1,
            },
          ],
        },
      );

    inventorySheet.columns =
      selectedFields.map(
        (field) => ({
          header:
            columnDefinitions[
              field
            ].header,

          key:
            columnDefinitions[
              field
            ].key,

          width:
            columnDefinitions[
              field
            ].width,
        }),
      );

    for (
      const server
      of servers
    ) {
      const valuesByField =
        this.getExportValues(
          server,
          false,
        );

      const rowData:
        Record<
          string,
          unknown
        > = {};

      for (
        const field
        of selectedFields
      ) {
        rowData[field] =
          valuesByField[
            field
          ];
      }

      inventorySheet.addRow(
        rowData,
      );
    }

    const inventoryHeader =
      inventorySheet.getRow(
        1,
      );

    inventoryHeader.font = {
      bold:
        true,
    };

    inventoryHeader.alignment = {
      vertical:
        'middle',

      horizontal:
        'center',
    };

    inventoryHeader.height =
      24;

    if (
      inventorySheet.columnCount >
      0
    ) {
      inventorySheet.autoFilter = {
        from: {
          row:
            1,

          column:
            1,
        },

        to: {
          row:
            1,

          column:
            inventorySheet.columnCount,
        },
      };
    }

    if (
      selectedFields.includes(
        'createdAt',
      )
    ) {
      inventorySheet.getColumn(
        'createdAt',
      ).numFmt =
        'dd-mm-yyyy hh:mm:ss';
    }

    if (
      selectedFields.includes(
        'updatedAt',
      )
    ) {
      inventorySheet.getColumn(
        'updatedAt',
      ).numFmt =
        'dd-mm-yyyy hh:mm:ss';
    }

    inventorySheet.eachRow(
      {
        includeEmpty:
          false,
      },
      (
        row,
        rowNumber,
      ) => {
        if (
          rowNumber ===
          1
        ) {
          return;
        }

        row.alignment = {
          vertical:
            'top',

          wrapText:
            true,
        };
      },
    );

    const summarySheet =
      workbook.addWorksheet(
        'Resumen',
      );

    const total =
      servers.length;

    const active =
      servers.filter(
        (server) =>
          server.active,
      ).length;

    const inactive =
      total -
      active;

    const environmentMap =
      new Map<
        string,
        number
      >();

    const companyMap =
      new Map<
        string,
        number
      >();

    const osMap =
      new Map<
        string,
        number
      >();

    const softwareMap =
      new Map<
        string,
        number
      >();

    for (
      const server
      of servers
    ) {
      const environment =
        server.environment ??
        'Sin ambiente';

      environmentMap.set(
        environment,

        (
          environmentMap.get(
            environment,
          ) ?? 0
        ) + 1,
      );

      const company =
        server.company
          ?.name ??
        'Sin empresa';

      companyMap.set(
        company,

        (
          companyMap.get(
            company,
          ) ?? 0
        ) + 1,
      );

      const operatingSystem =
        server.operatingSystem
          ? `${server.operatingSystem.name} ${server.operatingSystem.version}`
          : 'Sin sistema operativo';

      osMap.set(
        operatingSystem,

        (
          osMap.get(
            operatingSystem,
          ) ?? 0
        ) + 1,
      );

      for (
        const item
        of server.software
      ) {
        const software =
          `${item.software.name} ${item.version}`;

        softwareMap.set(
          software,

          (
            softwareMap.get(
              software,
            ) ?? 0
          ) + 1,
        );
      }
    }

    summarySheet.columns = [
      {
        width:
          34,
      },

      {
        width:
          16,
      },
    ];

    summarySheet.addRow([
      'Resumen InfraStock',
    ]);

    summarySheet.mergeCells(
      'A1:B1',
    );

    const titleCell =
      summarySheet.getCell(
        'A1',
      );

    titleCell.font = {
      bold:
        true,

      size:
        16,
    };

    summarySheet.addRow([]);

    summarySheet.addRow([
      'Métrica',
      'Cantidad',
    ]);

    summarySheet.addRow([
      'Servidores',
      total,
    ]);

    summarySheet.addRow([
      'Activos',
      active,
    ]);

    summarySheet.addRow([
      'Inactivos',
      inactive,
    ]);

    this.styleSummaryHeader(
      summarySheet.getRow(
        3,
      ),
    );

    summarySheet.addRow([]);

    this.addSummarySection(
      summarySheet,
      'Por ambiente',
      environmentMap,
    );

    summarySheet.addRow([]);

    this.addSummarySection(
      summarySheet,
      'Por empresa',
      companyMap,
    );

    summarySheet.addRow([]);

    this.addSummarySection(
      summarySheet,
      'Por sistema operativo',
      osMap,
    );

    summarySheet.addRow([]);

    this.addSummarySection(
      summarySheet,
      'Software instalado',
      softwareMap,
    );

    const output =
      await workbook.xlsx.writeBuffer();

    return Buffer.from(
      output,
    );
  }

  async findAccessibleCompanies(
    currentUser: CurrentUser,
  ) {
    return getAccessibleCompanies(
      this.prisma,
      currentUser,
    );
  }

  async findOne(
    id: number,
    currentUser: CurrentUser,
  ) {
    const server =
      await this.prisma.server.findUnique({
        where: {
          id,
        },

        include:
          this.getServerInclude(),
      });

    if (!server) {
      throw new NotFoundException(
        'Servidor no encontrado',
      );
    }

    if (!server.companyId) {
      if (
        currentUser.role !==
        Role.ADMIN
      ) {
        throw new ForbiddenException(
          'No tienes acceso a este servidor',
        );
      }
    } else {
      await assertCompanyAccessible(
        this.prisma,
        currentUser,
        server.companyId,
      );
    }

    return server;
  }

  async create(
    dto: CreateServerDto,
    currentUser: CurrentUser,
  ) {
    const hostname =
      dto.hostname.trim();

    const normalizedIp =
      dto.ipAddress?.trim() ||
      null;

    const existingServer =
      await this.prisma.server.findUnique({
        where: {
          hostname,
        },

        select: {
          id:
            true,
        },
      });

    if (
      existingServer
    ) {
      throw new ConflictException(
        'Ya existe un servidor con ese hostname',
      );
    }

    if (
      dto.active === false &&
      normalizedIp
    ) {
      throw new BadRequestException(
        'Un servidor inactivo no puede conservar una IP asignada. Actívalo primero o crea el registro sin IP',
      );
    }

    if (
      normalizedIp
    ) {
      await this.assertManagedIpAssignable(
        normalizedIp,
      );

      const existingIp =
        await this.prisma.server.findUnique({
          where: {
            ipAddress:
              normalizedIp,
          },

          select: {
            id:
              true,

            hostname:
              true,

            active:
              true,
          },
        });

      if (
        existingIp
      ) {
        throw new ConflictException(
          existingIp.active
            ? `La IP ${normalizedIp} se encuentra en uso por el servidor ${existingIp.hostname}`
            : `La IP ${normalizedIp} está asociada históricamente al servidor inactivo ${existingIp.hostname}. Libera el vínculo desde Administración IP antes de reutilizarla`,
        );
      }
    }

    const companyId =
      dto.companyId ??
      currentUser.companyId;

    if (!companyId) {
      throw new ConflictException(
        'Debe indicar la empresa del servidor',
      );
    }

    await assertActiveCompanyAccessible(
      this.prisma,
      currentUser,
      companyId,
    );

    try {
      const created =
        await this.prisma.$transaction(
          async (tx) => {
            const createdServer = await tx.server.create({
          data: {
            hostname,

            ipAddress:
              normalizedIp,

            environment:
              dto.environment,

            cpuCores:
              dto.cpuCores,

            ramGb:
              dto.ramGb,

            diskGb:
              dto.diskGb,

            notes:
              dto.notes,

            active:
              dto.active ??
              true,

            servicesOnitec:
              dto.servicesOnitec ??
              true,

            companyId,

            operatingSystemId:
              dto.operatingSystemId,

            createdById:
              currentUser.sub,

            updatedById:
              currentUser.sub,

            software:
              dto.software
                ? {
                    create:
                      dto.software.map(
                        (item) => ({
                          softwareId:
                            item.softwareId,

                          version:
                            item.version.trim(),

                          notes:
                            item.notes?.trim(),
                        }),
                      ),
                  }
                : undefined,
          },
            });

            await tx.auditLog.create({
              data: {
        action:
          'CREATE',

        entityType:
          'SERVER',

        entityId:
          createdServer.id,

        entityName:
          createdServer.hostname,

        userId:
          currentUser.sub,

        companyId:
          createdServer.companyId,

                details: {
                  message: 'Servidor creado',
                },
              },
            });

            return createdServer;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

      return this.findOne(
        created.id,
        currentUser,
      );
    } catch (error) {
      this.handleUniqueConstraintError(
        error,
        normalizedIp,
      );

      throw error;
    }
  }

  async update(
    id: number,
    dto: UpdateServerDto,
    currentUser: CurrentUser,
    options: ServerUpdateInternalOptions = {},
  ) {
    const existingServer =
      await this.findOne(
        id,
        currentUser,
      );

    const targetActive =
      options.targetActive ??
      existingServer.active;

    const hasStateTransition =
      targetActive !==
      existingServer.active;

    if (
      dto.active !== undefined &&
      dto.active !== existingServer.active
    ) {
      throw new BadRequestException(
        'Para cambiar el estado del servidor utiliza las acciones Activar o Desactivar',
      );
    }

    const normalizedIp =
      dto.ipAddress !==
      undefined
        ? dto.ipAddress?.trim() ||
          null
        : existingServer.ipAddress;

    if (
      dto.hostname
    ) {
      const hostname =
        dto.hostname.trim();

      const duplicate =
        await this.prisma.server.findFirst({
          where: {
            hostname,

            NOT: {
              id,
            },
          },

          select: {
            id:
              true,
          },
        });

      if (
        duplicate
      ) {
        throw new ConflictException(
          'Ya existe un servidor con ese hostname',
        );
      }
    }

    if (
      !existingServer.active &&
      !targetActive &&
      normalizedIp &&
      normalizedIp !== existingServer.ipAddress
    ) {
      throw new BadRequestException(
        'No se puede asignar una IP a un servidor inactivo. Activa el servidor primero',
      );
    }

    if (
      normalizedIp &&
      (normalizedIp !==
        existingServer.ipAddress ||
        (!existingServer.active &&
          targetActive))
    ) {
      await this.assertManagedIpAssignable(
        normalizedIp,
        id,
      );

      const existingIp =
        await this.prisma.server.findFirst({
          where: {
            ipAddress:
              normalizedIp,

            NOT: {
              id,
            },
          },

          select: {
            id:
              true,

            hostname:
              true,

            active:
              true,
          },
        });

      if (
        existingIp
      ) {
        throw new ConflictException(
          existingIp.active
            ? `La IP ${normalizedIp} se encuentra en uso por el servidor ${existingIp.hostname}`
            : `La IP ${normalizedIp} está asociada históricamente al servidor inactivo ${existingIp.hostname}. Libera el vínculo desde Administración IP antes de reutilizarla`,
        );
      }
    }

    let companyIdForUpdate:
      | number
      | undefined;

    if (
      dto.companyId !==
      undefined
    ) {
      await assertActiveCompanyAccessible(
        this.prisma,
        currentUser,
        dto.companyId,
      );

      companyIdForUpdate =
        dto.companyId;
    }

    const changes:
      AuditChange[] = [];

    if (
      dto.hostname !==
      undefined
    ) {
      const before =
        existingServer.hostname;

      const after =
        dto.hostname.trim();

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'hostname',

          label:
            'Hostname',

          before,

          after,

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      dto.ipAddress !==
      undefined
    ) {
      const before =
        existingServer.ipAddress;

      const after =
        normalizedIp;

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'ipAddress',

          label:
            'Dirección IP',

          before,

          after,

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      dto.environment !==
      undefined
    ) {
      const before =
        existingServer.environment;

      const after =
        dto.environment;

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'environment',

          label:
            'Ambiente',

          before,

          after,

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      dto.cpuCores !==
      undefined
    ) {
      const before =
        existingServer.cpuCores;

      const after =
        dto.cpuCores;

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'cpuCores',

          label:
            'CPU cores',

          before,

          after,

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      dto.ramGb !==
      undefined
    ) {
      const before =
        existingServer.ramGb;

      const after =
        dto.ramGb;

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'ramGb',

          label:
            'RAM',

          before,

          after,

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      dto.diskGb !==
      undefined
    ) {
      const before =
        existingServer.diskGb;

      const after =
        dto.diskGb;

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'diskGb',

          label:
            'Disco',

          before,

          after,

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      dto.notes !==
      undefined
    ) {
      const before =
        existingServer.notes;

      const after =
        dto.notes;

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'notes',

          label:
            'Notas',

          before,

          after,

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      dto.servicesOnitec !==
      undefined
    ) {
      const before =
        existingServer.servicesOnitec;

      const after =
        dto.servicesOnitec;

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'servicesOnitec',

          label:
            'Servicios Onitec',

          before:
            before
              ? 'Sí'
              : 'No',

          after:
            after
              ? 'Sí'
              : 'No',

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      dto.active !==
      undefined
    ) {
      const before =
        existingServer.active;

      const after =
        dto.active;

      if (
        before !==
        after
      ) {
        changes.push({
          field:
            'active',

          label:
            'Estado',

          before:
            before
              ? 'Activo'
              : 'Inactivo',

          after:
            after
              ? 'Activo'
              : 'Inactivo',

          beforeValue:
            before,

          afterValue:
            after,
        });
      }
    }

    if (
      companyIdForUpdate !==
        undefined &&
      companyIdForUpdate !==
        existingServer.companyId
    ) {
      const newCompany =
        await this.prisma.company.findUnique({
          where: {
            id:
              companyIdForUpdate,
          },

          select: {
            name:
              true,
          },
        });

      changes.push({
        field:
          'companyId',

        label:
          'Empresa',

        before:
          existingServer.company
            ?.name ??
          null,

        after:
          newCompany?.name ??
          null,

        beforeValue:
          existingServer.companyId,

        afterValue:
          companyIdForUpdate,
      });
    }

    if (
      dto.operatingSystemId !==
        undefined &&
      dto.operatingSystemId !==
        existingServer.operatingSystemId
    ) {
      const newOperatingSystem =
        dto.operatingSystemId
          ? await this.prisma.operatingSystem.findUnique({
              where: {
                id:
                  dto.operatingSystemId,
              },

              select: {
                name:
                  true,

                version:
                  true,
              },
            })
          : null;

      if (
        dto.operatingSystemId &&
        !newOperatingSystem
      ) {
        throw new NotFoundException(
          'Sistema operativo no encontrado',
        );
      }

      changes.push({
        field:
          'operatingSystemId',

        label:
          'Sistema Operativo',

        before:
          existingServer.operatingSystem
            ? `${existingServer.operatingSystem.name} ${existingServer.operatingSystem.version}`
            : null,

        after:
          newOperatingSystem
            ? `${newOperatingSystem.name} ${newOperatingSystem.version}`
            : null,

        beforeValue:
          existingServer.operatingSystemId,

        afterValue:
          dto.operatingSystemId,
      });
    }

    let softwareChanged =
      false;

    if (
      dto.software !==
      undefined
    ) {
      const beforeSoftware =
        existingServer.software
          .map(
            (item) => ({
              softwareId:
                item.softwareId,

              name:
                item.software.name,

              version:
                item.version,

              notes:
                item.notes ??
                null,
            }),
          )
          .sort(
            (
              a,
              b,
            ) =>
              a.softwareId -
              b.softwareId,
          );

      const softwareIds =
        dto.software.map(
          (item) =>
            item.softwareId,
        );

      const softwareRecords =
        softwareIds.length >
        0
          ? await this.prisma.software.findMany({
              where: {
                id: {
                  in:
                    softwareIds,
                },
              },

              select: {
                id:
                  true,

                name:
                  true,
              },
            })
          : [];

      if (
        softwareRecords.length !==
        new Set(
          softwareIds,
        ).size
      ) {
        throw new NotFoundException(
          'Uno o más software indicados no existen',
        );
      }

      const softwareNames =
        new Map(
          softwareRecords.map(
            (item) => [
              item.id,
              item.name,
            ],
          ),
        );

      const afterSoftware =
        dto.software
          .map(
            (item) => ({
              softwareId:
                item.softwareId,

              name:
                softwareNames.get(
                  item.softwareId,
                ) ??
                `Software ${item.softwareId}`,

              version:
                item.version.trim(),

              notes:
                item.notes?.trim() ??
                null,
            }),
          )
          .sort(
            (
              a,
              b,
            ) =>
              a.softwareId -
              b.softwareId,
          );

      softwareChanged =
        JSON.stringify(
          beforeSoftware,
        ) !==
        JSON.stringify(
          afterSoftware,
        );

      if (
        softwareChanged
      ) {
        changes.push({
          field:
            'software',

          label:
            'Software instalado',

          before:
            beforeSoftware.map(
              (item) =>
                `${item.name} ${item.version}`,
            ),

          after:
            afterSoftware.map(
              (item) =>
                `${item.name} ${item.version}`,
            ),

          beforeValue:
            beforeSoftware.map(
              (item) => ({
                softwareId:
                  item.softwareId,

                version:
                  item.version,

                notes:
                  item.notes,
              }),
            ),

          afterValue:
            afterSoftware.map(
              (item) => ({
                softwareId:
                  item.softwareId,

                version:
                  item.version,

                notes:
                  item.notes,
              }),
            ),
        });
      }
    }

    if (
      changes.length ===
        0 &&
      !hasStateTransition
    ) {
      return existingServer;
    }

    try {
      const updated =
        await this.prisma.$transaction(
          async (tx) => {
            const updatedServer = await tx.server.update({
          where: {
            id,
          },

          data: {
            hostname:
              dto.hostname?.trim(),

            ipAddress:
              hasStateTransition &&
              !targetActive
                ? null
                : dto.ipAddress !==
                    undefined
                  ? normalizedIp
                  : undefined,

            environment:
              dto.environment,

            cpuCores:
              dto.cpuCores,

            ramGb:
              dto.ramGb,

            diskGb:
              dto.diskGb,

            notes:
              dto.notes,

            servicesOnitec:
              dto.servicesOnitec,

            active:
              hasStateTransition
                ? targetActive
                : dto.active,

            companyId:
              companyIdForUpdate,

            operatingSystemId:
              dto.operatingSystemId,

            updatedById:
              currentUser.sub,

            software:
              softwareChanged
                ? {
                    deleteMany:
                      {},

                    create:
                      dto.software?.map(
                        (item) => ({
                          softwareId:
                            item.softwareId,

                          version:
                            item.version.trim(),

                          notes:
                            item.notes?.trim(),
                        }),
                      ) ??
                      [],
                  }
                : undefined,
          },
            });

            if (
              hasStateTransition &&
              targetActive
            ) {
              await tx.auditLog.create({
                data: {
                  action: 'ACTIVATE',
                  entityType: 'SERVER',
                  entityId: updatedServer.id,
                  entityName: updatedServer.hostname,
                  userId: currentUser.sub,
                  companyId: updatedServer.companyId,
                  details: {
                    message: 'Servidor activado',
                    fields: ['active'],
                    changes: [
                      {
                        field: 'active',
                        label: 'Estado',
                        before: 'Inactivo',
                        after: 'Activo',
                        beforeValue: false,
                        afterValue: true,
                      },
                    ],
                  },
                },
              });
            }

            if (changes.length > 0) {
              await tx.auditLog.create({
                data: {
                  action: 'UPDATE',
                  entityType: 'SERVER',
                  entityId: updatedServer.id,
                  entityName: updatedServer.hostname,
                  userId: currentUser.sub,
                  companyId: updatedServer.companyId,
                  details: {
                    message: 'Servidor actualizado',
                    fields: changes.map((change) => change.field),
                    changes: changes as unknown as Prisma.InputJsonValue,
                  },
                },
              });
            }

            if (
              hasStateTransition &&
              !targetActive
            ) {
              const previousIp = normalizedIp;
              const stateChanges: AuditChange[] = [
                {
                  field: 'active',
                  label: 'Estado',
                  before: 'Activo',
                  after: 'Inactivo',
                  beforeValue: true,
                  afterValue: false,
                },
              ];

              if (previousIp) {
                stateChanges.push({
                  field: 'ipAddress',
                  label: 'IP',
                  before: previousIp,
                  after: null,
                  beforeValue: previousIp,
                  afterValue: null,
                });
              }

              await tx.auditLog.create({
                data: {
                  action: 'DEACTIVATE',
                  entityType: 'SERVER',
                  entityId: updatedServer.id,
                  entityName: updatedServer.hostname,
                  userId: currentUser.sub,
                  companyId: updatedServer.companyId,
                  details: {
                    message: previousIp
                      ? `Servidor desactivado. La IP ${previousIp} fue liberada`
                      : 'Servidor desactivado',
                    fields: stateChanges.map((change) => change.field),
                    changes: stateChanges as unknown as Prisma.InputJsonValue,
                  },
                },
              });
            }

            return updatedServer;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

      return this.findOne(
        updated.id,
        currentUser,
      );
    } catch (error) {
      this.handleUniqueConstraintError(
        error,
        normalizedIp,
      );

      throw error;
    }
  }

  async updateWithStateTransitionForImport(
    id: number,
    dto: UpdateServerDto,
    targetActive: boolean,
    currentUser: CurrentUser,
  ) {
    const current = await this.findOne(
      id,
      currentUser,
    );

    if (current.active === targetActive) {
      throw new ConflictException(
        targetActive
          ? 'El servidor ya está activo; vuelva a prevalidar el archivo'
          : 'El servidor ya está inactivo; vuelva a prevalidar el archivo',
      );
    }

    return this.update(
      id,
      dto,
      currentUser,
      { targetActive },
    );
  }

  async deactivate(
    id: number,
    currentUser: CurrentUser,
  ) {
    const existingServer =
      await this.findOne(
        id,
        currentUser,
      );

    if (!existingServer.active) {
      throw new ConflictException(
        'El servidor ya está desactivado',
      );
    }

    const previousIp =
      existingServer.ipAddress;

    const changes: AuditChange[] = [
      {
        field: 'active',
        label: 'Estado',
        before: 'Activo',
        after: 'Inactivo',
        beforeValue: true,
        afterValue: false,
      },
    ];

    if (previousIp) {
      changes.push({
        field: 'ipAddress',
        label: 'IP',
        before: previousIp,
        after: null,
        beforeValue: previousIp,
        afterValue: null,
      });
    }

    await this.prisma.$transaction(
      async (tx) => {
        await tx.server.update({
          where: { id },
          data: {
            active: false,
            ipAddress: null,
            updatedById: currentUser.sub,
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'DEACTIVATE',
            entityType: 'SERVER',
            entityId: id,
            entityName: existingServer.hostname,
            userId: currentUser.sub,
            companyId: existingServer.companyId,
            details: {
              message: previousIp
                ? `Servidor desactivado. La IP ${previousIp} fue liberada`
                : 'Servidor desactivado',
              fields: changes.map((change) => change.field),
              changes: changes as unknown as Prisma.InputJsonValue,
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.findOne(
      id,
      currentUser,
    );
  }

  async activate(
    id: number,
    currentUser: CurrentUser,
  ) {
    const existingServer =
      await this.findOne(
        id,
        currentUser,
      );

    if (existingServer.active) {
      throw new ConflictException(
        'El servidor ya está activo',
      );
    }

    if (existingServer.companyId) {
      await assertActiveCompanyAccessible(
        this.prisma,
        currentUser,
        existingServer.companyId,
      );
    }

    if (existingServer.ipAddress) {
      await this.assertManagedIpAssignable(
        existingServer.ipAddress,
        id,
      );
    }

    await this.prisma.$transaction(
      async (tx) => {
        await tx.server.update({
          where: { id },
          data: {
            active: true,
            updatedById: currentUser.sub,
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'ACTIVATE',
            entityType: 'SERVER',
            entityId: id,
            entityName: existingServer.hostname,
            userId: currentUser.sub,
            companyId: existingServer.companyId,
            details: {
              message: 'Servidor activado',
              fields: ['active'],
              changes: [
                {
                  field: 'active',
                  label: 'Estado',
                  before: 'Inactivo',
                  after: 'Activo',
                  beforeValue: false,
                  afterValue: true,
                },
              ],
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.findOne(
      id,
      currentUser,
    );
  }

  async remove(
    id: number,
    currentUser: CurrentUser,
  ) {
    const server =
      await this.findOne(
        id,
        currentUser,
      );

    await this.prisma.$transaction(
      async (tx) => {
        await tx.auditLog.create({
          data: {
            action: 'DELETE',
            entityType: 'SERVER',
            entityId: server.id,
            entityName: server.hostname,
            userId: currentUser.sub,
            companyId: server.companyId,
            details: {
              message: 'Servidor eliminado',
              hostname: server.hostname,
              ipAddress: server.ipAddress,
              environment: server.environment,
            },
          },
        });

        await tx.server.delete({
          where: {
            id,
          },
        });
      },
      {
        isolationLevel:
          Prisma.TransactionIsolationLevel
            .Serializable,
      },
    );

    return {
      message:
        `Servidor ${server.hostname} eliminado correctamente`,
    };
  }

  private getSelectedExportFields(
    filters: ServerFilters,
  ): ServerExportField[] {
    if (
      filters.fields?.length
    ) {
      return [
        ...filters.fields,
      ];
    }

    return [
      ...DEFAULT_SERVER_EXPORT_FIELDS,
    ];
  }

  private getExportHeaders():
    Record<
      ServerExportField,
      string
    > {
    return {
      hostname:
        'Hostname',

      company:
        'Empresa',

      ipAddress:
        'IP',

      environment:
        'Ambiente',

      operatingSystem:
        'Sistema Operativo',

      cpuCores:
        'CPU',

      ramGb:
        'RAM GB',

      diskGb:
        'Disco GB',

      software:
        'Software',

      active:
        'Estado',

      notes:
        'Notas',

      createdAt:
        'Fecha creación',

      createdBy:
        'Creado por',

      updatedAt:
        'Última modificación',

      updatedBy:
        'Modificado por',
    };
  }

  private getExportColumnDefinitions():
    Record<
      ServerExportField,
      ExportColumnDefinition
    > {
    return {
      hostname: {
        header:
          'Hostname',

        key:
          'hostname',

        width:
          28,
      },

      company: {
        header:
          'Empresa',

        key:
          'company',

        width:
          20,
      },

      ipAddress: {
        header:
          'IP',

        key:
          'ipAddress',

        width:
          18,
      },

      environment: {
        header:
          'Ambiente',

        key:
          'environment',

        width:
          12,
      },

      operatingSystem: {
        header:
          'Sistema Operativo',

        key:
          'operatingSystem',

        width:
          26,
      },

      cpuCores: {
        header:
          'CPU',

        key:
          'cpuCores',

        width:
          10,
      },

      ramGb: {
        header:
          'RAM GB',

        key:
          'ramGb',

        width:
          12,
      },

      diskGb: {
        header:
          'Disco GB',

        key:
          'diskGb',

        width:
          14,
      },

      software: {
        header:
          'Software',

        key:
          'software',

        width:
          45,
      },

      active: {
        header:
          'Estado',

        key:
          'active',

        width:
          12,
      },

      notes: {
        header:
          'Notas',

        key:
          'notes',

        width:
          40,
      },

      createdAt: {
        header:
          'Fecha creación',

        key:
          'createdAt',

        width:
          20,
      },

      createdBy: {
        header:
          'Creado por',

        key:
          'createdBy',

        width:
          28,
      },

      updatedAt: {
        header:
          'Última modificación',

        key:
          'updatedAt',

        width:
          22,
      },

      updatedBy: {
        header:
          'Modificado por',

        key:
          'updatedBy',

        width:
          28,
      },
    };
  }

  private getExportValues(
    server: Awaited<
      ReturnType<
        ServersService[
          'getServersForExport'
        ]
      >
    >[number],

    formatDatesAsText:
      boolean,
  ): Record<
    ServerExportField,
    unknown
  > {
    const operatingSystem =
      server.operatingSystem
        ? `${server.operatingSystem.name} ${server.operatingSystem.version}`
        : '';

    const software =
      server.software
        .map(
          (item) =>
            `${item.software.name} ${item.version}`,
        )
        .join(
          ' | ',
        );

    const createdBy =
      server.createdBy
        ? `${server.createdBy.username} - ${server.createdBy.name}`
        : '';

    const updatedBy =
      server.updatedBy
        ? `${server.updatedBy.username} - ${server.updatedBy.name}`
        : '';

    return {
      hostname:
        server.hostname,

      company:
        server.company
          ?.name ??
        '',

      ipAddress:
        server.ipAddress ??
        '',

      environment:
        server.environment ??
        '',

      operatingSystem,

      cpuCores:
        server.cpuCores ??
        '',

      ramGb:
        server.ramGb ??
        '',

      diskGb:
        server.diskGb ??
        '',

      software,

      active:
        server.active
          ? 'Activo'
          : 'Inactivo',

      notes:
        server.notes ??
        '',

      createdAt:
        formatDatesAsText
          ? this.formatCsvDate(
              server.createdAt,
            )
          : server.createdAt,

      createdBy,

      updatedAt:
        formatDatesAsText
          ? this.formatCsvDate(
              server.updatedAt,
            )
          : server.updatedAt,

      updatedBy,
    };
  }

  private async getServersForExport(
    currentUser: CurrentUser,
    filters: ServerFilters,
  ) {
    const sortBy =
      filters.sortBy ??
      'hostname';

    const sortOrder =
      filters.sortOrder ??
      'asc';

    const where =
      await this.buildWhere(
        currentUser,
        filters,
      );

    const orderBy =
      this.buildOrderBy(
        sortBy,
        sortOrder,
      );

    return this.prisma.server.findMany({
      where,

      include:
        this.getServerInclude(),

      orderBy,
    });
  }

  private async buildSecurityWhere(
    currentUser: CurrentUser,
    requestedCompanyId?: number,
  ): Promise<Prisma.ServerWhereInput> {
    return buildScopedServerCompanyWhere(
      this.prisma,
      currentUser,
      requestedCompanyId,
    );
  }

  private async buildWhere(
    currentUser: CurrentUser,
    filters: ServerFilters,
  ): Promise<Prisma.ServerWhereInput> {
    const securityWhere =
      await this.buildSecurityWhere(
        currentUser,
        filters.companyId,
      );

    const filterWhere:
      Prisma.ServerWhereInput = {};

    if (
      filters.environment
    ) {
      filterWhere.environment =
        filters.environment;
    }

    if (
      filters.operatingSystemId !==
      undefined
    ) {
      filterWhere.operatingSystemId =
        filters.operatingSystemId;
    }

    if (
      filters.softwareId !==
        undefined ||
      filters.softwareVersion
    ) {
      filterWhere.software = {
        some: {
          ...(filters.softwareId !==
          undefined
            ? {
                softwareId:
                  filters.softwareId,
              }
            : {}),

          ...(filters.softwareVersion
            ? {
                version: {
                  equals:
                    filters.softwareVersion,

                  mode:
                    'insensitive',
                },
              }
            : {}),
        },
      };
    }

    if (
      filters.inventoryIssue
    ) {
      switch (
        filters.inventoryIssue
      ) {
        case 'missingIp':
          filterWhere.ipAddress =
            null;
          break;

        case 'missingOperatingSystem':
          filterWhere.operatingSystemId =
            null;
          break;

        case 'incompleteResources':
          filterWhere.AND = [
            {
              OR: [
                {
                  cpuCores:
                    null,
                },
                {
                  ramGb:
                    null,
                },
                {
                  diskGb:
                    null,
                },
              ],
            },
          ];
          break;

        case 'missingSoftware':
          filterWhere.software = {
            none: {},
          };
          break;
      }
    }

    if (
      filters.qualityIssueCount
    ) {
      const missingIp: Prisma.ServerWhereInput = {
        ipAddress: null,
      };

      const hasIp: Prisma.ServerWhereInput = {
        ipAddress: { not: null },
      };

      const missingOperatingSystem: Prisma.ServerWhereInput = {
        operatingSystemId: null,
      };

      const hasOperatingSystem: Prisma.ServerWhereInput = {
        operatingSystemId: { not: null },
      };

      const incompleteResources: Prisma.ServerWhereInput = {
        OR: [
          { cpuCores: null },
          { ramGb: null },
          { diskGb: null },
        ],
      };

      const completeResources: Prisma.ServerWhereInput = {
        AND: [
          { cpuCores: { not: null } },
          { ramGb: { not: null } },
          { diskGb: { not: null } },
        ],
      };

      const missingSoftware: Prisma.ServerWhereInput = {
        software: { none: {} },
      };

      const hasSoftware: Prisma.ServerWhereInput = {
        software: { some: {} },
      };

      const issuePairs = [
        [missingIp, hasIp],
        [missingOperatingSystem, hasOperatingSystem],
        [incompleteResources, completeResources],
        [missingSoftware, hasSoftware],
      ] as const;

      const exactCountConditions = (
        count: number,
      ): Prisma.ServerWhereInput[] => {
        const results: Prisma.ServerWhereInput[] = [];

        for (let mask = 0; mask < 16; mask += 1) {
          let issueCount = 0;

          for (let index = 0; index < 4; index += 1) {
            if (mask & (1 << index)) {
              issueCount += 1;
            }
          }

          if (issueCount !== count) {
            continue;
          }

          results.push({
            AND: issuePairs.map((pair, index) =>
              mask & (1 << index)
                ? pair[0]
                : pair[1],
            ),
          });
        }

        return results;
      };

      const qualityConditions =
        filters.qualityIssueCount === '3plus'
          ? [
              ...exactCountConditions(3),
              ...exactCountConditions(4),
            ]
          : exactCountConditions(
              Number(filters.qualityIssueCount),
            );

      const existingAnd = Array.isArray(filterWhere.AND)
        ? filterWhere.AND
        : filterWhere.AND
          ? [filterWhere.AND]
          : [];

      filterWhere.AND = [
        ...existingAnd,
        {
          OR: qualityConditions,
        },
      ];
    }

    if (
      filters.inventoryFreshness
    ) {
      const now =
        new Date();

      const daysAgo = (
        days: number,
      ) =>
        new Date(
          now.getTime() -
            days * 24 * 60 * 60 * 1000,
        );

      const day30 =
        daysAgo(30);

      const day60 =
        daysAgo(60);

      const day90 =
        daysAgo(90);

      switch (
        filters.inventoryFreshness
      ) {
        case 'recent':
          filterWhere.updatedAt = {
            gte: day30,
          };
          break;

        case 'days30to59':
          filterWhere.updatedAt = {
            gte: day60,
            lt: day30,
          };
          break;

        case 'days60to89':
          filterWhere.updatedAt = {
            gte: day90,
            lt: day60,
          };
          break;

        case 'days90plus':
          filterWhere.updatedAt = {
            lt: day90,
          };
          break;
      }
    }

    if (
      filters.active !==
      undefined
    ) {
      filterWhere.active =
        filters.active;
    }

    const search =
      filters.search?.trim();

    if (
      search
    ) {
      const searchConditions:
        Prisma.ServerWhereInput[] = [
          {
            hostname: {
              contains:
                search,

              mode:
                'insensitive',
            },
          },

          {
            environment: {
              contains:
                search,

              mode:
                'insensitive',
            },
          },

          {
            notes: {
              contains:
                search,

              mode:
                'insensitive',
            },
          },

          {
            company: {
              is: {
                name: {
                  contains:
                    search,

                  mode:
                    'insensitive',
                },
              },
            },
          },

          {
            company: {
              is: {
                slug: {
                  contains:
                    search,

                  mode:
                    'insensitive',
                },
              },
            },
          },

          {
            operatingSystem: {
              is: {
                name: {
                  contains:
                    search,

                  mode:
                    'insensitive',
                },
              },
            },
          },

          {
            operatingSystem: {
              is: {
                version: {
                  contains:
                    search,

                  mode:
                    'insensitive',
                },
              },
            },
          },

          {
            software: {
              some: {
                software: {
                  name: {
                    contains:
                      search,

                    mode:
                      'insensitive',
                  },
                },
              },
            },
          },

          {
            software: {
              some: {
                version: {
                  contains:
                    search,

                  mode:
                    'insensitive',
                },
              },
            },
          },

          {
            createdBy: {
              is: {
                username: {
                  contains:
                    search,

                  mode:
                    'insensitive',
                },
              },
            },
          },

          {
            updatedBy: {
              is: {
                username: {
                  contains:
                    search,

                  mode:
                    'insensitive',
                },
              },
            },
          },
        ];

      if (
        this.isValidIpAddress(
          search,
        )
      ) {
        searchConditions.push({
          ipAddress:
            search,
        });
      }

      if (
        this.isValidCidr(
          search,
        )
      ) {
        const networkMatches =
          await this.findServerIdsByNetwork(
            search,
          );

        const networkIds =
          networkMatches.map(
            (item) =>
              item.id,
          );

        if (
          networkIds.length >
          0
        ) {
          searchConditions.push({
            id: {
              in:
                networkIds,
            },
          });
        }
      }

      filterWhere.OR =
        searchConditions;
    }

    if (
      filters.softwareSupportStatus
    ) {
      const candidateServers =
        await this.prisma.server.findMany({
          where: {
            AND: [
              securityWhere,
              filterWhere,
            ],
          },

          select: {
            id: true,

            software: {
              select: {
                version: true,

                software: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        });

      const versionsBySoftware =
        new Map<string, Set<string>>();

      for (
        const server of
        candidateServers
      ) {
        for (
          const installation of
          server.software
        ) {
          const name =
            installation.software.name;

          const version =
            installation.version.trim();

          if (!version) {
            continue;
          }

          const versions =
            versionsBySoftware.get(
              name,
            ) ??
            new Set<string>();

          versions.add(
            version,
          );

          versionsBySoftware.set(
            name,
            versions,
          );
        }
      }

      const analysisBySoftware =
        new Map<
          string,
          Awaited<
            ReturnType<
              EndOfLifeService['analyzeSoftware']
            >
          >
        >();

      await Promise.all(
        Array.from(
          versionsBySoftware.entries(),
        ).map(
          async ([name, versions]) => {
            const analysis =
              await this.endOfLifeService.analyzeSoftware(
                name,
                Array.from(versions),
              );

            analysisBySoftware.set(
              name,
              analysis,
            );
          },
        ),
      );

      const matchingServerIds =
        candidateServers
          .filter(
            (server) =>
              server.software.some(
                (installation) => {
                  const analysis =
                    analysisBySoftware.get(
                      installation.software.name,
                    );

                  if (!analysis) {
                    return false;
                  }

                  const versionStatus =
                    analysis.versions.find(
                      (item) =>
                        item.installedVersion ===
                        installation.version.trim(),
                    );

                  return (
                    versionStatus?.status ===
                    filters.softwareSupportStatus
                  );
                },
              ),
          )
          .map(
            (server) =>
              server.id,
          );

      const existingAnd =
        Array.isArray(
          filterWhere.AND,
        )
          ? filterWhere.AND
          : filterWhere.AND
            ? [
                filterWhere.AND,
              ]
            : [];

      filterWhere.AND = [
        ...existingAnd,
        {
          id: {
            in:
              matchingServerIds,
          },
        },
      ];
    }


    if (
      filters.inventoryConfidence
    ) {
      const candidateServers =
        await this.prisma.server.findMany({
          where: {
            AND: [
              securityWhere,
              filterWhere,
            ],
          },

          select: {
            id:
              true,

            ipAddress:
              true,

            operatingSystemId:
              true,

            cpuCores:
              true,

            ramGb:
              true,

            diskGb:
              true,

            updatedAt:
              true,

            _count: {
              select: {
                software:
                  true,
              },
            },
          },
        });

      const now =
        new Date();

      const matchingServerIds =
        candidateServers
          .filter(
            (server) =>
              calculateInventoryConfidence(
                {
                  ipAddress:
                    server.ipAddress,

                  operatingSystemId:
                    server.operatingSystemId,

                  cpuCores:
                    server.cpuCores,

                  ramGb:
                    server.ramGb,

                  diskGb:
                    server.diskGb,

                  updatedAt:
                    server.updatedAt,

                  softwareCount:
                    server._count.software,
                },
                now,
              ).level ===
              filters.inventoryConfidence,
          )
          .map(
            (server) =>
              server.id,
          );

      const existingAnd =
        Array.isArray(
          filterWhere.AND,
        )
          ? filterWhere.AND
          : filterWhere.AND
            ? [
                filterWhere.AND,
              ]
            : [];

      filterWhere.AND = [
        ...existingAnd,
        {
          id: {
            in:
              matchingServerIds,
          },
        },
      ];
    }

    return {
      AND: [
        securityWhere,
        filterWhere,
      ],
    };
  }

  private isValidIpAddress(
    value: string,
  ): boolean {
    return (
      isIP(
        value,
      ) !==
      0
    );
  }

  private isValidCidr(
    value: string,
  ): boolean {
    const slashIndex =
      value.lastIndexOf(
        '/',
      );

    if (
      slashIndex <= 0 ||
      slashIndex ===
        value.length -
          1
    ) {
      return false;
    }

    const address =
      value.slice(
        0,
        slashIndex,
      );

    const prefixText =
      value.slice(
        slashIndex +
          1,
      );

    if (
      !/^\d+$/.test(
        prefixText,
      )
    ) {
      return false;
    }

    const family =
      isIP(
        address,
      );

    if (
      family ===
      0
    ) {
      return false;
    }

    const prefix =
      Number(
        prefixText,
      );

    if (
      !Number.isInteger(
        prefix,
      )
    ) {
      return false;
    }

    if (
      family ===
      4
    ) {
      return (
        prefix >=
          0 &&
        prefix <=
          32
      );
    }

    if (
      family ===
      6
    ) {
      return (
        prefix >=
          0 &&
        prefix <=
          128
      );
    }

    return false;
  }

  private async findServerIdsByNetwork(
    network: string,
  ): Promise<ServerIdRow[]> {
    return this.prisma.$queryRaw<
      ServerIdRow[]
    >`
      SELECT
        "id"
      FROM
        "Server"
      WHERE
        "ipAddress" IS NOT NULL
        AND "ipAddress" <<= ${network}::inet
    `;
  }

  private getServerInclude() {
    return {
      company:
        true,

      operatingSystem:
        true,

      createdBy: {
        select: {
          id:
            true,

          username:
            true,

          name:
            true,
        },
      },

      updatedBy: {
        select: {
          id:
            true,

          username:
            true,

          name:
            true,
        },
      },

      software: {
        include: {
          software:
            true,
        },

        orderBy: {
          software: {
            name:
              'asc' as const,
          },
        },
      },
    };
  }

  private buildOrderBy(
    sortBy: ServerSortBy,
    sortOrder: ServerSortOrder,
  ): Prisma.ServerOrderByWithRelationInput[] {
    switch (
      sortBy
    ) {
      case 'company':
        return [
          {
            company: {
              name:
                sortOrder,
            },
          },

          {
            hostname:
              'asc',
          },

          {
            id:
              'asc',
          },
        ];

      case 'operatingSystem':
        return [
          {
            operatingSystem: {
              name:
                sortOrder,
            },
          },

          {
            operatingSystem: {
              version:
                sortOrder,
            },
          },

          {
            hostname:
              'asc',
          },

          {
            id:
              'asc',
          },
        ];

      case 'ipAddress':
        return [
          {
            ipAddress:
              sortOrder,
          },

          {
            hostname:
              'asc',
          },

          {
            id:
              'asc',
          },
        ];

      case 'environment':
        return [
          {
            environment:
              sortOrder,
          },

          {
            hostname:
              'asc',
          },

          {
            id:
              'asc',
          },
        ];

      case 'cpuCores':
        return [
          {
            cpuCores:
              sortOrder,
          },

          {
            hostname:
              'asc',
          },

          {
            id:
              'asc',
          },
        ];

      case 'ramGb':
        return [
          {
            ramGb:
              sortOrder,
          },

          {
            hostname:
              'asc',
          },

          {
            id:
              'asc',
          },
        ];

      case 'diskGb':
        return [
          {
            diskGb:
              sortOrder,
          },

          {
            hostname:
              'asc',
          },

          {
            id:
              'asc',
          },
        ];

      case 'updatedAt':
        return [
          {
            updatedAt:
              sortOrder,
          },

          {
            hostname:
              'asc',
          },

          {
            id:
              'asc',
          },
        ];

      case 'hostname':
      default:
        return [
          {
            hostname:
              sortOrder,
          },

          {
            id:
              'asc',
          },
        ];
    }
  }

  private styleSummaryHeader(
    row: ExcelJS.Row,
  ) {
    row.font = {
      bold:
        true,
    };

    row.alignment = {
      vertical:
        'middle',
    };
  }

  private addSummarySection(
    sheet:
      ExcelJS.Worksheet,

    title:
      string,

    values:
      Map<
        string,
        number
      >,
  ) {
    const titleRow =
      sheet.addRow([
        title,
        'Cantidad',
      ]);

    this.styleSummaryHeader(
      titleRow,
    );

    const ordered =
      Array.from(
        values.entries(),
      )
        .map(
          (
            [
              name,
              count,
            ],
          ) => ({
            name,

            count,
          }),
        )
        .sort(
          (
            a,
            b,
          ) =>
            b.count -
              a.count ||
            a.name.localeCompare(
              b.name,
            ),
        );

    for (
      const item
      of ordered
    ) {
      sheet.addRow([
        item.name,
        item.count,
      ]);
    }
  }

  private escapeCsvValue(
    value:
      unknown,
  ): string {
    if (
      value ===
        null ||
      value ===
        undefined
    ) {
      return '';
    }

    const text =
      String(
        value,
      );

    if (
      text.includes(
        ';',
      ) ||
      text.includes(
        '"',
      ) ||
      text.includes(
        '\n',
      ) ||
      text.includes(
        '\r',
      )
    ) {
      return `"${text.replace(
        /"/g,
        '""',
      )}"`;
    }

    return text;
  }

  private formatCsvDate(
    value:
      Date,
  ): string {
    const year =
      value.getFullYear();

    const month =
      String(
        value.getMonth() +
          1,
      ).padStart(
        2,
        '0',
      );

    const day =
      String(
        value.getDate(),
      ).padStart(
        2,
        '0',
      );

    const hours =
      String(
        value.getHours(),
      ).padStart(
        2,
        '0',
      );

    const minutes =
      String(
        value.getMinutes(),
      ).padStart(
        2,
        '0',
      );

    const seconds =
      String(
        value.getSeconds(),
      ).padStart(
        2,
        '0',
      );

    return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
  }

  private async assertManagedIpAssignable(
    ipAddress: string,
    serverId?: number,
  ): Promise<void> {
    const ipVersion =
      isIP(ipAddress);

    if (ipVersion === 0) {
      throw new BadRequestException(
        'Dirección IP inválida',
      );
    }

    // La Etapa 11 administra redes IPv4. IPv6 conserva el comportamiento
    // existente y no se fuerza todavía contra el catálogo de redes.
    if (ipVersion === 6) {
      return;
    }

    const networks =
      await this.prisma.network.findMany({
        where: {
          active: true,
        },
        select: {
          id: true,
          name: true,
          cidr: true,
        },
      });

    const network = networks.find(
      (item) =>
        isUsableIpv4InCidr(
          ipAddress,
          item.cidr,
        ),
    );

    if (!network) {
      throw new BadRequestException(
        `La IP ${ipAddress} no pertenece al rango utilizable de una red activa registrada en InfraStock`,
      );
    }

    const reservation =
      await this.prisma.ipReservation.findFirst({
        where: {
          active: true,
          ipAddress,
        },
        select: {
          id: true,
          description: true,
        },
      });

    if (reservation) {
      throw new ConflictException(
        reservation.description
          ? `La IP ${ipAddress} está reservada: ${reservation.description}`
          : `La IP ${ipAddress} está reservada`,
      );
    }

    const activeServer =
      await this.prisma.server.findFirst({
        where: {
          active: true,
          ipAddress,
          ...(serverId
            ? {
                NOT: {
                  id: serverId,
                },
              }
            : {}),
        },
        select: {
          hostname: true,
        },
      });

    if (activeServer) {
      throw new ConflictException(
        `La IP ${ipAddress} se encuentra en uso por el servidor ${activeServer.hostname}`,
      );
    }
  }

  private handleUniqueConstraintError(
    error:
      unknown,

    ipAddress:
      string | null,
  ): void {
    if (
      error instanceof
        Prisma.PrismaClientKnownRequestError &&
      error.code ===
        'P2002'
    ) {
      const target =
        error.meta?.target;

      const targetText =
        Array.isArray(
          target,
        )
          ? target.join(
              ',',
            )
          : String(
              target ??
                '',
            );

      if (
        targetText.includes(
          'ipAddress',
        )
      ) {
        throw new ConflictException(
          ipAddress
            ? `La IP ${ipAddress} se encuentra en uso por otro servidor`
            : 'La IP se encuentra en uso por otro servidor',
        );
      }

      if (
        targetText.includes(
          'hostname',
        )
      ) {
        throw new ConflictException(
          'Ya existe un servidor con ese hostname',
        );
      }
    }
  }
}