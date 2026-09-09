import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { MediaStorageService, type UploadedMediaFile } from '../media/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { CreateCompanyDto } from './dto/create-company.dto.js';
import { UpdateCompanyDto } from './dto/update-company.dto.js';

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

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaStorage: MediaStorageService,
  ) {}

  findAll() {
    return this.prisma.company.findMany({
      include: {
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

        _count: {
          select: {
            users: true,
            servers: true,
          },
        },
      },

      orderBy: {
        name: 'asc',
      },
    });
  }

  async findOne(id: number) {
    const company =
      await this.prisma.company.findUnique({
        where: {
          id,
        },

        include: {
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

          _count: {
            select: {
              users: true,
              servers: true,
            },
          },
        },
      });

    if (!company) {
      throw new NotFoundException(
        'Empresa no encontrada',
      );
    }

    return company;
  }

  async create(
    dto: CreateCompanyDto,
    currentUser: CurrentUser,
  ) {
    const name =
      dto.name.trim();

    const slug =
      dto.slug
        .trim()
        .toLowerCase();

    try {
      const companyId =
        await this.prisma.$transaction(
          async (tx) => {
            const existing =
              await tx.company.findUnique({
                where: {
                  slug,
                },
                select: {
                  id: true,
                },
              });

            if (existing) {
              throw new ConflictException(
                'Ya existe una empresa con ese slug',
              );
            }

            const company =
              await tx.company.create({
                data: {
                  name,
                  slug,

                  logoUrl: null,

                  primaryColor:
                    dto.primaryColor ??
                    '#2563EB',

                  secondaryColor:
                    dto.secondaryColor ??
                    '#0F172A',

                  backgroundColor:
                    dto.backgroundColor ??
                    '#F1F5F9',

                  surfaceColor:
                    dto.surfaceColor ??
                    '#FFFFFF',

                  textColor:
                    dto.textColor ??
                    '#0F172A',

                  logoBackgroundColor:
                    dto.logoBackgroundColor ??
                    '#FFFFFF',

                  active:
                    dto.active ?? true,

                  createdById:
                    currentUser.sub,

                  updatedById:
                    currentUser.sub,
                },

                select: {
                  id: true,
                  name: true,
                },
              });

            await tx.auditLog.create({
              data: {
                action: 'CREATE',
                entityType: 'COMPANY',
                entityId: company.id,
                entityName: company.name,
                userId: currentUser.sub,
                companyId: company.id,

                details: {
                  message:
                    'Empresa creada',
                },
              },
            });

            return company.id;
          },
        );

      return this.findOne(companyId);
    } catch (error) {
      this.handleCompanyUniqueConflict(
        error,
      );
      throw error;
    }
  }

  async update(
    id: number,
    dto: UpdateCompanyDto,
    currentUser: CurrentUser,
  ) {
    const current =
      await this.findOne(id);

    this.assertOwnCompanyRemainsActive(
      id,
      dto,
      currentUser,
    );

    const normalizedName =
      dto.name !== undefined
        ? dto.name.trim()
        : current.name;

    const normalizedSlug =
      dto.slug !== undefined
        ? dto.slug
            .trim()
            .toLowerCase()
        : current.slug;

    const normalizedLogoUrl =
      current.logoUrl;

    const changes: AuditChange[] =
      [];

    if (
      normalizedName !==
      current.name
    ) {
      changes.push({
        field: 'name',
        label: 'Nombre',
        before:
          current.name,
        after:
          normalizedName,
      });
    }

    if (
      normalizedSlug !==
      current.slug
    ) {
      changes.push({
        field: 'slug',
        label: 'Slug',
        before:
          current.slug,
        after:
          normalizedSlug,
      });
    }

    if (
      normalizedLogoUrl !==
      current.logoUrl
    ) {
      changes.push({
        field: 'logoUrl',
        label: 'Logo',
        before:
          current.logoUrl,
        after:
          normalizedLogoUrl,
      });
    }

    const colorChanges = [
      {
        field: 'primaryColor',
        label: 'Color primario',
        value: dto.primaryColor,
        currentValue:
          current.primaryColor,
      },
      {
        field: 'secondaryColor',
        label: 'Color secundario',
        value: dto.secondaryColor,
        currentValue:
          current.secondaryColor,
      },
      {
        field: 'backgroundColor',
        label: 'Color de fondo',
        value: dto.backgroundColor,
        currentValue:
          current.backgroundColor,
      },
      {
        field: 'surfaceColor',
        label: 'Color de superficie',
        value: dto.surfaceColor,
        currentValue:
          current.surfaceColor,
      },
      {
        field: 'textColor',
        label: 'Color de texto',
        value: dto.textColor,
        currentValue:
          current.textColor,
      },
      {
        field: 'logoBackgroundColor',
        label: 'Fondo del logo',
        value:
          dto.logoBackgroundColor,
        currentValue:
          current.logoBackgroundColor,
      },
    ] as const;

    for (
      const colorChange of
      colorChanges
    ) {
      if (
        colorChange.value !==
          undefined &&
        colorChange.value !==
          colorChange.currentValue
      ) {
        changes.push({
          field:
            colorChange.field,
          label:
            colorChange.label,
          before:
            colorChange.currentValue,
          after:
            colorChange.value,
        });
      }
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
            ? 'Activa'
            : 'Inactiva',
        after:
          dto.active
            ? 'Activa'
            : 'Inactiva',
      });
    }

    if (
      changes.length === 0
    ) {
      return current;
    }

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

    try {
      const companyId =
        await this.prisma.$transaction(
          async (tx) => {
            const persisted =
              await tx.company.findUnique({
                where: {
                  id,
                },
                select: {
                  id: true,
                  slug: true,
                  active: true,
                },
              });

            if (!persisted) {
              throw new NotFoundException(
                'Empresa no encontrada',
              );
            }

            this.assertOwnCompanyRemainsActive(
              id,
              dto,
              currentUser,
            );

            if (
              normalizedSlug !==
              persisted.slug
            ) {
              const existing =
                await tx.company.findFirst({
                  where: {
                    slug:
                      normalizedSlug,

                    NOT: {
                      id,
                    },
                  },

                  select: {
                    id: true,
                  },
                });

              if (existing) {
                throw new ConflictException(
                  'Ya existe una empresa con ese slug',
                );
              }
            }

            const company =
              await tx.company.update({
                where: {
                  id,
                },

                data: {
                  name:
                    normalizedName,

                  slug:
                    normalizedSlug,

                  logoUrl:
                    normalizedLogoUrl,

                  primaryColor:
                    dto.primaryColor,

                  secondaryColor:
                    dto.secondaryColor,

                  backgroundColor:
                    dto.backgroundColor,

                  surfaceColor:
                    dto.surfaceColor,

                  textColor:
                    dto.textColor,

                  logoBackgroundColor:
                    dto.logoBackgroundColor,

                  active:
                    dto.active,

                  updatedById:
                    currentUser.sub,
                },

                select: {
                  id: true,
                  name: true,
                },
              });

            await tx.auditLog.create({
              data: {
                action,
                entityType: 'COMPANY',
                entityId: company.id,
                entityName: company.name,
                userId: currentUser.sub,
                companyId: company.id,

                details: {
                  message:
                    action ===
                    'ACTIVATE'
                      ? 'Empresa activada'
                      : action ===
                          'DEACTIVATE'
                        ? 'Empresa desactivada'
                        : 'Empresa actualizada',

                  fields:
                    changes.map(
                      (change) =>
                        change.field,
                    ),

                  changes:
                    changes as unknown as Prisma.InputJsonValue,
                },
              },
            });

            return company.id;
          },
        );

      return this.findOne(companyId);
    } catch (error) {
      this.handleCompanyUniqueConflict(
        error,
      );
      throw error;
    }
  }

  async uploadLogo(
    id: number,
    file: UploadedMediaFile,
    currentUser: CurrentUser,
  ) {
    const current =
      await this.findOne(id);

    const logoUrl =
      await this.mediaStorage.saveCompanyLogo(
        file,
      );

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.company.update({
            where: { id },
            data: {
              logoUrl,
              updatedById:
                currentUser.sub,
            },
          });

          await tx.auditLog.create({
            data: {
              action: 'UPDATE',
              entityType: 'COMPANY',
              entityId: id,
              entityName: current.name,
              userId: currentUser.sub,
              companyId: id,
              details: {
                message: 'Logo de empresa actualizado',
                fields: ['logoUrl'],
              },
            },
          });
        },
      );
    } catch (error) {
      await this.mediaStorage.deleteManaged(
        logoUrl,
      );
      throw error;
    }

    await this.mediaStorage.deleteManaged(
      current.logoUrl,
    );

    return this.findOne(id);
  }

  async removeLogo(
    id: number,
    currentUser: CurrentUser,
  ) {
    const current =
      await this.findOne(id);

    if (!current.logoUrl) {
      return current;
    }

    await this.prisma.$transaction(
      async (tx) => {
        await tx.company.update({
          where: { id },
          data: {
            logoUrl: null,
            updatedById:
              currentUser.sub,
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: 'COMPANY',
            entityId: id,
            entityName: current.name,
            userId: currentUser.sub,
            companyId: id,
            details: {
              message: 'Logo de empresa eliminado; se utilizará el logo predeterminado',
              fields: ['logoUrl'],
            },
          },
        });
      },
    );

    await this.mediaStorage.deleteManaged(
      current.logoUrl,
    );

    return this.findOne(id);
  }

  async remove(
    id: number,
    currentUser: CurrentUser,
  ) {
    const current =
      await this.findOne(id);

    if (
      current.slug
        .trim()
        .toLowerCase() ===
      'onitec'
    ) {
      throw new ForbiddenException(
        'La empresa Onitec es la empresa base y no se puede eliminar',
      );
    }

    if (
      currentUser.companyId ===
      id
    ) {
      throw new ForbiddenException(
        'No puedes eliminar la empresa asociada a tu propia cuenta',
      );
    }

    const onitec =
      await this.prisma.company.findFirst({
        where: {
          slug: {
            equals: 'onitec',
            mode: 'insensitive',
          },
        },
        select: {
          id: true,
          name: true,
          active: true,
        },
      });

    if (!onitec) {
      throw new ConflictException(
        'No existe la empresa base Onitec. No es posible eliminar la empresa de forma segura.',
      );
    }

    if (!onitec.active) {
      throw new ConflictException(
        'La empresa base Onitec está inactiva. Actívala antes de eliminar otra empresa.',
      );
    }

    const result =
      await this.prisma.$transaction(
        async (tx) => {
          const servers =
            await tx.server.updateMany({
              where: {
                companyId: id,
              },
              data: {
                companyId: onitec.id,
                updatedById:
                  currentUser.sub,
              },
            });

          /*
           * User.companyId no tiene onDelete: SetNull. Para conservar las
           * cuentas y evitar referencias inválidas, los usuarios de la empresa
           * eliminada también pasan a Onitec.
           */
          const users =
            await tx.user.updateMany({
              where: {
                companyId: id,
              },
              data: {
                companyId: onitec.id,
                tokenVersion: {
                  increment: 1,
                },
              },
            });

          const credentials =
            await tx.credential.updateMany({
              where: {
                companyId: id,
              },
              data: {
                companyId: onitec.id,
                updatedById:
                  currentUser.sub,
              },
            });

          await tx.auditLog.create({
            data: {
              action: 'DELETE',
              entityType: 'COMPANY',
              entityId: current.id,
              entityName: current.name,
              userId: currentUser.sub,
              companyId: current.id,
              details: {
                message: 'Empresa eliminada y recursos reasignados a Onitec',
                reassignedToCompanyId: onitec.id,
                reassignedToCompanyName: onitec.name,
                serversReassigned: servers.count,
                usersReassigned: users.count,
                credentialsReassigned: credentials.count,
              },
            },
          });

          await tx.company.delete({
            where: {
              id,
            },
          });

          return {
            serversReassigned:
              servers.count,
            usersReassigned:
              users.count,
            credentialsReassigned:
              credentials.count,
          };
        },
      );

    await this.mediaStorage.deleteManaged(
      current.logoUrl,
    );

    return {
      id: current.id,
      name: current.name,
      deleted: true,
      reassignedTo: onitec.name,
      ...result,
    };
  }

  private assertOwnCompanyRemainsActive(
    companyId: number,
    dto: UpdateCompanyDto,
    currentUser: CurrentUser,
  ) {
    if (
      dto.active === false &&
      currentUser.companyId ===
        companyId
    ) {
      throw new ForbiddenException(
        'No puedes desactivar la empresa asociada a tu propia cuenta',
      );
    }
  }

  private handleCompanyUniqueConflict(
    error: unknown,
  ) {
    if (
      error instanceof
        Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const target =
        Array.isArray(
          error.meta?.target,
        )
          ? error.meta.target.join(
              ',',
            )
          : String(
              error.meta?.target ??
                '',
            );

      if (
        target
          .toLowerCase()
          .includes('slug')
      ) {
        throw new ConflictException(
          'Ya existe una empresa con ese slug',
        );
      }

      throw new ConflictException(
        'Ya existe una empresa con los datos indicados',
      );
    }
  }
}
