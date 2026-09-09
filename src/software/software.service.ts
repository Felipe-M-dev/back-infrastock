import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  Prisma,
  type Role,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

import type { CreateSoftwareDto } from './dto/create-software.dto.js';
import type { UpdateSoftwareDto } from './dto/update-software.dto.js';

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
}

const softwareInclude = {
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
} satisfies Prisma.SoftwareInclude;

@Injectable()
export class SoftwareService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  findAll() {
    return this.prisma.software.findMany({
      include: softwareInclude,
      orderBy: [
        {
          category: 'asc',
        },
        {
          name: 'asc',
        },
      ],
    });
  }

  async findOne(
    id: number,
  ) {
    return this.getSoftware(id);
  }

  async create(
    dto: CreateSoftwareDto,
    currentUser: CurrentUser,
  ) {
    const name =
      dto.name.trim();

    if (!name) {
      throw new BadRequestException(
        'El nombre del sistema es obligatorio',
      );
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const duplicate =
            await tx.software.findFirst({
              where: {
                name: {
                  equals: name,
                  mode: 'insensitive',
                },
              },
              select: {
                id: true,
              },
            });

          if (duplicate) {
            throw new ConflictException(
              `Ya existe el sistema ${name}`,
            );
          }

          const created =
            await tx.software.create({
              data: {
                name,
                category:
                  dto.category,
                active:
                  dto.active ?? true,
                createdById:
                  currentUser.sub,
                updatedById:
                  currentUser.sub,
              },
              include:
                softwareInclude,
            });

          await tx.auditLog.create({
            data: {
              action: 'CREATE',
              entityType: 'SOFTWARE',
              entityId:
                created.id,
              entityName:
                created.name,
              userId:
                currentUser.sub,
              companyId: null,
              details:
                this.toInputJsonValue({
                  message:
                    'Sistema creado',
                  category:
                    created.category,
                  active:
                    created.active,
                }),
            },
          });

          return created;
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
    dto: UpdateSoftwareDto,
    currentUser: CurrentUser,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const current =
            await this.getSoftware(
              id,
              tx,
            );

          const name =
            dto.name !== undefined
              ? dto.name.trim()
              : current.name;

          if (!name) {
            throw new BadRequestException(
              'El nombre del sistema es obligatorio',
            );
          }

          const category =
            dto.category ??
            current.category;

          const active =
            dto.active ??
            current.active;

          const duplicate =
            await tx.software.findFirst({
              where: {
                id: {
                  not: id,
                },
                name: {
                  equals: name,
                  mode: 'insensitive',
                },
              },
              select: {
                id: true,
              },
            });

          if (duplicate) {
            throw new ConflictException(
              `Ya existe el sistema ${name}`,
            );
          }

          const changes: AuditChange[] =
            [];

          if (
            name !==
            current.name
          ) {
            changes.push({
              field: 'name',
              label: 'Sistema',
              before:
                current.name,
              after:
                name,
            });
          }

          if (
            category !==
            current.category
          ) {
            changes.push({
              field: 'category',
              label: 'Categoría',
              before:
                current.category,
              after:
                category,
            });
          }

          if (
            active !==
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
                active
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
            {
              name,
              category,
              active,
            },
            tx,
          );

          const onlyActiveChanged =
            changes.length === 1 &&
            changes[0].field ===
              'active';

          const action =
            onlyActiveChanged
              ? active
                ? 'ACTIVATE'
                : 'DEACTIVATE'
              : 'UPDATE';

          const updated =
            await tx.software.update({
              where: {
                id,
              },
              data: {
                name,
                category,
                active,
                updatedById:
                  currentUser.sub,
              },
              include:
                softwareInclude,
            });

          await tx.auditLog.create({
            data: {
              action,
              entityType: 'SOFTWARE',
              entityId:
                updated.id,
              entityName:
                updated.name,
              userId:
                currentUser.sub,
              companyId: null,
              details:
                this.toInputJsonValue({
                  message:
                    action ===
                    'ACTIVATE'
                      ? 'Sistema activado'
                      : action ===
                          'DEACTIVATE'
                        ? 'Sistema desactivado'
                        : 'Sistema modificado',
                  fields:
                    changes.map(
                      (change) =>
                        change.field,
                    ),
                  changes,
                  before: {
                    name:
                      current.name,
                    category:
                      current.category,
                    active:
                      current.active,
                  },
                  after: {
                    name:
                      updated.name,
                    category:
                      updated.category,
                    active:
                      updated.active,
                  },
                }),
            },
          });

          return updated;
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

  private async getSoftware(
    id: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client =
      tx ?? this.prisma;

    const software =
      await client.software.findUnique({
        where: {
          id,
        },
        include:
          softwareInclude,
      });

    if (!software) {
      throw new NotFoundException(
        'Sistema no encontrado',
      );
    }

    return software;
  }

  private async assertPricingConsistency(
    current: {
      id: number;
      name: string;
      category: string;
      active: boolean;
    },
    next: {
      name: string;
      category: string;
      active: boolean;
    },
    tx: Prisma.TransactionClient,
  ) {
    const tariff =
      await tx.pricingTariff.findFirst({
        where: {
          softwareId:
            current.id,
        },
        select: {
          id: true,
          name: true,
          active: true,
        },
      });

    if (!tariff) {
      return;
    }

    if (
      next.name !==
      current.name
    ) {
      throw new ConflictException(
        `No se puede cambiar el nombre de ${current.name}: existe una tarifa asociada (${tariff.name})`,
      );
    }

    if (
      next.category !==
        current.category &&
      next.category !==
        'DATABASE'
    ) {
      throw new ConflictException(
        `No se puede cambiar la categoría de ${current.name}: existe una tarifa asociada (${tariff.name})`,
      );
    }

    if (
      current.active &&
      !next.active &&
      tariff.active
    ) {
      throw new ConflictException(
        `No se puede desactivar ${current.name}: existe una tarifa activa asociada (${tariff.name})`,
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
          'Ya existe un sistema con ese nombre',
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
