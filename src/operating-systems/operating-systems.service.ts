import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

import { CreateOperatingSystemDto } from './dto/create-operating-system.dto.js';
import { UpdateOperatingSystemDto } from './dto/update-operating-system.dto.js';

interface CurrentUser {
  sub: number;
  username: string;
  companyId?: number | null;
}

interface AuditChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

const operatingSystemInclude = {
  createdBy: {
    select: {
      id: true,
      username: true,
      name: true,
    },
  },
  updatedBy: {
    select: {
      id: true,
      username: true,
      name: true,
    },
  },
} satisfies Prisma.OperatingSystemInclude;

@Injectable()
export class OperatingSystemsService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  findAll() {
    return this.prisma.operatingSystem.findMany({
      include: operatingSystemInclude,
      orderBy: [
        {
          name: 'asc',
        },
        {
          version: 'asc',
        },
      ],
    });
  }

  async findOne(
    id: number,
  ) {
    return this.getOperatingSystem(id);
  }

  async create(
    dto: CreateOperatingSystemDto,
    currentUser: CurrentUser,
  ) {
    const name =
      dto.name.trim();

    const version =
      dto.version.trim();

    if (!name) {
      throw new BadRequestException(
        'El nombre del sistema operativo es obligatorio',
      );
    }

    if (!version) {
      throw new BadRequestException(
        'La versión del sistema operativo es obligatoria',
      );
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const existing =
            await tx.operatingSystem.findFirst({
              where: {
                name: {
                  equals: name,
                  mode: 'insensitive',
                },
                version: {
                  equals: version,
                  mode: 'insensitive',
                },
              },
              select: {
                id: true,
              },
            });

          if (existing) {
            throw new ConflictException(
              'Ese sistema operativo y versión ya existen',
            );
          }

          const operatingSystem =
            await tx.operatingSystem.create({
              data: {
                name,
                version,
                active:
                  dto.active ?? true,
                createdById:
                  currentUser.sub,
                updatedById:
                  currentUser.sub,
              },
              include:
                operatingSystemInclude,
            });

          await tx.auditLog.create({
            data: {
              action: 'CREATE',
              entityType:
                'OPERATING_SYSTEM',
              entityId:
                operatingSystem.id,
              entityName:
                `${operatingSystem.name} ${operatingSystem.version}`,
              userId:
                currentUser.sub,
              companyId: null,
              details:
                this.toInputJsonValue({
                  message:
                    'Sistema operativo creado',
                }),
            },
          });

          return operatingSystem;
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel
              .Serializable,
        },
      );
    } catch (error) {
      this.handleWriteError(error);
      throw error;
    }
  }

  async update(
    id: number,
    dto: UpdateOperatingSystemDto,
    currentUser: CurrentUser,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const current =
            await this.getOperatingSystem(
              id,
              tx,
            );

          const normalizedName =
            dto.name !== undefined
              ? dto.name.trim()
              : current.name;

          const normalizedVersion =
            dto.version !== undefined
              ? dto.version.trim()
              : current.version;

          if (!normalizedName) {
            throw new BadRequestException(
              'El nombre del sistema operativo es obligatorio',
            );
          }

          if (!normalizedVersion) {
            throw new BadRequestException(
              'La versión del sistema operativo es obligatoria',
            );
          }

          const duplicate =
            await tx.operatingSystem.findFirst({
              where: {
                id: {
                  not: id,
                },
                name: {
                  equals:
                    normalizedName,
                  mode: 'insensitive',
                },
                version: {
                  equals:
                    normalizedVersion,
                  mode: 'insensitive',
                },
              },
              select: {
                id: true,
              },
            });

          if (duplicate) {
            throw new ConflictException(
              'Ese sistema operativo y versión ya existen',
            );
          }

          const changes: AuditChange[] =
            [];

          if (
            normalizedName !==
            current.name
          ) {
            changes.push({
              field: 'name',
              label:
                'Sistema Operativo',
              before:
                current.name,
              after:
                normalizedName,
            });
          }

          if (
            normalizedVersion !==
            current.version
          ) {
            changes.push({
              field: 'version',
              label: 'Versión',
              before:
                current.version,
              after:
                normalizedVersion,
            });
          }

          if (
            dto.active !==
              undefined &&
            dto.active !==
              current.active
          ) {
            changes.push({
              field: 'active',
              label: 'Estado',
              before:
                current.active
                  ? 'Activo'
                  : 'Inactivo',
              after:
                dto.active
                  ? 'Activo'
                  : 'Inactivo',
            });
          }

          if (
            changes.length === 0
          ) {
            return current;
          }

          await this.assertPricingConsistency(
            current,
            normalizedName,
            dto.active ?? current.active,
            tx,
          );

          const onlyActiveChanged =
            changes.length === 1 &&
            changes[0].field ===
              'active';

          let action =
            'UPDATE';

          if (onlyActiveChanged) {
            action =
              dto.active
                ? 'ACTIVATE'
                : 'DEACTIVATE';
          }

          const operatingSystem =
            await tx.operatingSystem.update({
              where: {
                id,
              },
              data: {
                name:
                  normalizedName,
                version:
                  normalizedVersion,
                active:
                  dto.active,
                updatedById:
                  currentUser.sub,
              },
              include:
                operatingSystemInclude,
            });

          await tx.auditLog.create({
            data: {
              action,
              entityType:
                'OPERATING_SYSTEM',
              entityId:
                operatingSystem.id,
              entityName:
                `${operatingSystem.name} ${operatingSystem.version}`,
              userId:
                currentUser.sub,
              companyId: null,
              details:
                this.toInputJsonValue({
                  message:
                    action ===
                    'ACTIVATE'
                      ? 'Sistema operativo activado'
                      : action ===
                          'DEACTIVATE'
                        ? 'Sistema operativo desactivado'
                        : 'Sistema operativo actualizado',
                  fields:
                    changes.map(
                      (change) =>
                        change.field,
                    ),
                  changes,
                }),
            },
          });

          return operatingSystem;
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel
              .Serializable,
        },
      );
    } catch (error) {
      this.handleWriteError(error);
      throw error;
    }
  }

  private async getOperatingSystem(
    id: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client =
      tx ?? this.prisma;

    const operatingSystem =
      await client.operatingSystem.findUnique({
        where: {
          id,
        },
        include:
          operatingSystemInclude,
      });

    if (!operatingSystem) {
      throw new NotFoundException(
        'Sistema operativo no encontrado',
      );
    }

    return operatingSystem;
  }

  private async assertPricingConsistency(
    current: {
      id: number;
      name: string;
      active: boolean;
    },
    nextName: string,
    nextActive: boolean,
    tx: Prisma.TransactionClient,
  ) {
    const leavesCurrentFamily =
      current.active &&
      (
        nextName !== current.name ||
        !nextActive
      );

    if (!leavesCurrentFamily) {
      return;
    }

    const otherActiveSameName =
      await tx.operatingSystem.findFirst({
        where: {
          id: {
            not: current.id,
          },
          active: true,
          name: {
            equals:
              current.name,
            mode: 'insensitive',
          },
        },
        select: {
          id: true,
        },
      });

    if (otherActiveSameName) {
      return;
    }

    const activeTariff =
      await tx.pricingTariff.findFirst({
        where: {
          active: true,
          operatingSystemName: {
            equals:
              current.name,
            mode: 'insensitive',
          },
        },
        select: {
          id: true,
          name: true,
        },
      });

    if (activeTariff) {
      throw new ConflictException(
        `No se puede dejar sin sistemas operativos activos a ${current.name}: existe una tarifa activa asociada (${activeTariff.name})`,
      );
    }
  }

  private toInputJsonValue(
    value: unknown,
  ): Prisma.InputJsonValue {
    const serialized =
      JSON.stringify(value);

    if (
      serialized === undefined
    ) {
      throw new BadRequestException(
        'Los detalles de auditoría no son serializables',
      );
    }

    return JSON.parse(
      serialized,
    ) as Prisma.InputJsonValue;
  }

  private handleWriteError(
    error: unknown,
  ): void {
    if (
      error instanceof
        Prisma.PrismaClientKnownRequestError
    ) {
      if (error.code === 'P2002') {
        throw new ConflictException(
          'Ese sistema operativo y versión ya existen',
        );
      }

      if (error.code === 'P2034') {
        throw new ConflictException(
          'La operación no pudo completarse porque el catálogo fue modificado simultáneamente. Actualiza e inténtalo nuevamente.',
        );
      }
    }
  }
}
