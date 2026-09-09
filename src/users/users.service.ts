import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import bcrypt from 'bcrypt';

import {
  Prisma,
  Role,
} from '@prisma/client';

import { MediaStorageService, type UploadedMediaFile } from '../media/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';

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

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaStorage: MediaStorageService,
  ) {}

  findAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        avatarUrl: true,
        role: true,
        active: true,
        companyId: true,

        company: {
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
          },
        },

        createdAt: true,
        updatedAt: true,
      },

      orderBy: {
        username: 'asc',
      },
    });
  }

  findByUsername(
    username: string,
  ) {
    /*
     * Este método se usa exclusivamente desde AuthService.
     * AuthService necesita passwordHash para bcrypt.compare().
     *
     * Nunca debe devolverse directamente desde un controller.
     */
    return this.prisma.user.findUnique({
      where: {
        username,
      },

      include: {
        company: true,
      },
    });
  }

  async findOne(
    id: number,
  ) {
    const user =
      await this.prisma.user.findUnique({
        where: {
          id,
        },

        select: {
          id: true,
          username: true,
          name: true,
          email: true,
          avatarUrl: true,
          role: true,
          active: true,
          companyId: true,

          company: {
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true,
            },
          },

          createdAt: true,
          updatedAt: true,
        },
      });

    if (!user) {
      throw new NotFoundException(
        'Usuario no encontrado',
      );
    }

    return user;
  }

  async create(
    dto: CreateUserDto,
    currentUser: CurrentUser,
  ) {
    const username =
      dto.username.trim();

    const name =
      dto.name.trim();

    const email =
      dto.email?.trim() ||
      null;

    const passwordHash =
      await bcrypt.hash(
        dto.password,
        12,
      );

    const createdId =
      await this.prisma.$transaction(
        async (
          tx,
        ) => {
          const existingUsername =
            await tx.user.findUnique({
              where: {
                username,
              },

              select: {
                id: true,
              },
            });

          if (existingUsername) {
            throw new ConflictException(
              'Ese usuario ya existe',
            );
          }

          if (email) {
            const existingEmail =
              await tx.user.findUnique({
                where: {
                  email,
                },

                select: {
                  id: true,
                },
              });

            if (existingEmail) {
              throw new ConflictException(
                'Ese email ya está asociado a otro usuario',
              );
            }
          }

          const company =
            await tx.company.findUnique({
              where: {
                id: dto.companyId,
              },

              select: {
                id: true,
                name: true,
                active: true,
              },
            });

          if (!company) {
            throw new NotFoundException(
              'Empresa no encontrada',
            );
          }

          if (!company.active) {
            throw new ConflictException(
              'No se puede asignar un usuario a una empresa inactiva',
            );
          }

          const created =
            await tx.user.create({
              data: {
                username,
                passwordHash,
                name,
                email,

                role:
                  dto.role,

                companyId:
                  dto.companyId,

                active:
                  dto.active ?? true,
              },
            });

          await tx.auditLog.create({
            data: {
              action:
                'CREATE',

              entityType:
                'USER',

              entityId:
                created.id,

              entityName:
                created.username,

              userId:
                currentUser.sub,

              companyId:
                created.companyId,

              details:
                this.toInputJsonValue({
                  message:
                    'Usuario creado',

                  changes: [
                    {
                      field:
                        'username',

                      label:
                        'Usuario',

                      before:
                        null,

                      after:
                        created.username,
                    },

                    {
                      field:
                        'name',

                      label:
                        'Nombre',

                      before:
                        null,

                      after:
                        created.name,
                    },

                    {
                      field:
                        'email',

                      label:
                        'Email',

                      before:
                        null,

                      after:
                        created.email,
                    },

                    {
                      field:
                        'role',

                      label:
                        'Rol',

                      before:
                        null,

                      after:
                        created.role,
                    },

                    {
                      field:
                        'companyId',

                      label:
                        'Empresa',

                      before:
                        null,

                      after:
                        company.name,
                    },

                    {
                      field:
                        'active',

                      label:
                        'Estado',

                      before:
                        null,

                      after:
                        created.active
                          ? 'Activo'
                          : 'Inactivo',
                    },

                    {
                      field:
                        'password',

                      label:
                        'Contraseña',

                      before:
                        null,

                      after:
                        'Configurada',
                    },
                  ],
                }),
            },
          });

          return created.id;
        },
      );

    return this.findOne(
      createdId,
    );
  }

  async update(
    id: number,
    dto: UpdateUserDto,
    currentUser: CurrentUser,
  ) {
    const current =
      await this.findOne(id);

    this.assertSelfProtection(
      current,
      dto,
      currentUser,
    );

    await this.assertAdminContinuityForUpdate(
      current,
      dto,
    );

    const normalizedUsername =
      dto.username !== undefined
        ? dto.username.trim()
        : current.username;

    const normalizedName =
      dto.name !== undefined
        ? dto.name.trim()
        : current.name;

    const normalizedEmail =
      dto.email !== undefined
        ? dto.email.trim() ||
          null
        : current.email;

    let newCompany:
      | {
          id: number;
          name: string;
          active: boolean;
        }
      | null = null;

    if (
      dto.companyId !== undefined
    ) {
      newCompany =
        await this.prisma.company.findUnique({
          where: {
            id:
              dto.companyId,
          },

          select: {
            id: true,
            name: true,
            active: true,
          },
        });

      if (!newCompany) {
        throw new NotFoundException(
          'Empresa no encontrada',
        );
      }

      if (!newCompany.active) {
        throw new ConflictException(
          'No se puede asignar un usuario a una empresa inactiva',
        );
      }
    }

    const changes: AuditChange[] =
      [];

    if (
      normalizedUsername !==
      current.username
    ) {
      changes.push({
        field: 'username',
        label: 'Usuario',
        before:
          current.username,
        after:
          normalizedUsername,
      });
    }

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
      normalizedEmail !==
      current.email
    ) {
      changes.push({
        field: 'email',
        label: 'Email',
        before:
          current.email,
        after:
          normalizedEmail,
      });
    }

    if (
      dto.role !== undefined &&
      dto.role !== current.role
    ) {
      changes.push({
        field: 'role',
        label: 'Rol',
        before:
          current.role,
        after:
          dto.role,
      });
    }

    if (
      dto.companyId !== undefined &&
      dto.companyId !==
        current.companyId
    ) {
      changes.push({
        field: 'companyId',
        label: 'Empresa',

        before:
          current.company?.name ??
          null,

        after:
          newCompany?.name ??
          null,
      });
    }

    if (
      dto.active !== undefined &&
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

    /*
     * El DTO ya impide una contraseña formada solo por
     * espacios. No aplicamos trim() al secreto porque los
     * espacios pueden formar parte legítima de la contraseña.
     */
    const passwordChanged =
      dto.password !== undefined;

    if (passwordChanged) {
      changes.push({
        field: 'password',
        label: 'Contraseña',
        before: 'Configurada',
        after: 'Actualizada',
      });
    }

    if (
      changes.length === 0
    ) {
      return current;
    }

    const passwordHash =
      passwordChanged
        ? await bcrypt.hash(
            dto.password!,
            12,
          )
        : undefined;

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

    const updatedId =
      await this.prisma.$transaction(
        async (
          tx,
        ) => {
          if (
            normalizedUsername !==
            current.username
          ) {
            const existing =
              await tx.user.findFirst({
                where: {
                  username:
                    normalizedUsername,

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
                'Ese usuario ya existe',
              );
            }
          }

          if (
            normalizedEmail &&
            normalizedEmail !==
              current.email
          ) {
            const existing =
              await tx.user.findFirst({
                where: {
                  email:
                    normalizedEmail,

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
                'Ese email ya está asociado a otro usuario',
              );
            }
          }

          /*
           * Revalidamos continuidad administrativa dentro de
           * la misma transacción para reducir la ventana entre
           * validación y escritura.
           */
          await this.assertAdminContinuityForUpdate(
            current,
            dto,
            tx,
          );

          const updated =
            await tx.user.update({
              where: {
                id,
              },

              data: {
                username:
                  normalizedUsername,

                passwordHash,

                tokenVersion:
                  passwordChanged
                    ? {
                        increment: 1,
                      }
                    : undefined,

                name:
                  normalizedName,

                email:
                  normalizedEmail,

                role:
                  dto.role,

                companyId:
                  dto.companyId,

                active:
                  dto.active,
              },
            });

          await tx.auditLog.create({
            data: {
              action,

              entityType:
                'USER',

              entityId:
                updated.id,

              entityName:
                updated.username,

              userId:
                currentUser.sub,

              companyId:
                updated.companyId,

              details:
                this.toInputJsonValue({
                  message:
                    action === 'ACTIVATE'
                      ? 'Usuario activado'
                      : action ===
                          'DEACTIVATE'
                        ? 'Usuario desactivado'
                        : 'Usuario actualizado',

                  fields:
                    changes.map(
                      (change) =>
                        change.field,
                    ),

                  changes,
                }),
            },
          });

          return updated.id;
        },
      );

    return this.findOne(
      updatedId,
    );
  }

  async remove(
    id: number,
    currentUser: CurrentUser,
  ) {
    const user =
      await this.findOne(id);

    if (
      id ===
      currentUser.sub
    ) {
      throw new ForbiddenException(
        'No puedes eliminar tu propia cuenta',
      );
    }

    await this.assertAdminContinuityForDelete(
      user,
    );

    await this.prisma.$transaction(
      async (
        tx,
      ) => {
        await this.assertAdminContinuityForDelete(
          user,
          tx,
        );

        /*
         * La auditoría se crea antes del DELETE dentro de la
         * misma transacción. Si cualquier paso falla, ambas
         * operaciones se revierten.
         *
         * AuditLog.userId tiene onDelete: SetNull, por lo que
         * si el usuario eliminado fuera el actor de registros
         * históricos esos eventos permanecen conservados.
         */
        await tx.auditLog.create({
          data: {
            action:
              'DELETE',

            entityType:
              'USER',

            entityId:
              user.id,

            entityName:
              user.username,

            userId:
              currentUser.sub,

            companyId:
              user.companyId,

            details:
              this.toInputJsonValue({
                message:
                  'Usuario eliminado',

                username:
                  user.username,

                name:
                  user.name,

                role:
                  user.role,

                company:
                  user.company?.name ??
                  null,
              }),
          },
        });

        await tx.user.delete({
          where: {
            id,
          },
        });
      },
    );

    return {
      message:
        `Usuario ${user.username} eliminado correctamente`,
    };
  }

  async updateOwnAvatar(
    userId: number,
    file: UploadedMediaFile,
  ) {
    return this.updateAvatar(
      userId,
      file,
      userId,
    );
  }

  async removeOwnAvatar(
    userId: number,
  ) {
    return this.removeAvatar(
      userId,
      userId,
    );
  }

  async updateAvatarByAdmin(
    userId: number,
    file: UploadedMediaFile,
    currentUser: CurrentUser,
  ) {
    return this.updateAvatar(
      userId,
      file,
      currentUser.sub,
    );
  }

  async removeAvatarByAdmin(
    userId: number,
    currentUser: CurrentUser,
  ) {
    return this.removeAvatar(
      userId,
      currentUser.sub,
    );
  }

  private async updateAvatar(
    userId: number,
    file: UploadedMediaFile,
    actorUserId: number,
  ) {
    const current =
      await this.findOne(userId);

    const avatarUrl =
      await this.mediaStorage.saveAvatar(
        file,
      );

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.user.update({
            where: { id: userId },
            data: { avatarUrl },
          });

          await tx.auditLog.create({
            data: {
              action: 'UPDATE',
              entityType: 'USER',
              entityId: userId,
              entityName: current.username,
              userId: actorUserId,
              companyId: current.companyId,
              details: {
                message:
                  actorUserId === userId
                    ? 'Foto de perfil actualizada'
                    : 'Foto de perfil actualizada por administrador',
                fields: ['avatarUrl'],
              },
            },
          });
        },
      );
    } catch (error) {
      await this.mediaStorage.deleteManaged(
        avatarUrl,
      );
      throw error;
    }

    await this.mediaStorage.deleteManaged(
      current.avatarUrl,
    );

    return this.findOne(userId);
  }

  private async removeAvatar(
    userId: number,
    actorUserId: number,
  ) {
    const current =
      await this.findOne(userId);

    if (!current.avatarUrl) {
      return current;
    }

    await this.prisma.$transaction(
      async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { avatarUrl: null },
        });

        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: 'USER',
            entityId: userId,
            entityName: current.username,
            userId: actorUserId,
            companyId: current.companyId,
            details: {
              message:
                actorUserId === userId
                  ? 'Foto de perfil eliminada'
                  : 'Foto de perfil eliminada por administrador',
              fields: ['avatarUrl'],
            },
          },
        });
      },
    );

    await this.mediaStorage.deleteManaged(
      current.avatarUrl,
    );

    return this.findOne(userId);
  }

  private assertSelfProtection(
    current: {
      id: number;
      role: Role;
      active: boolean;
    },
    dto: UpdateUserDto,
    currentUser: CurrentUser,
  ) {
    if (
      current.id !==
      currentUser.sub
    ) {
      return;
    }

    if (
      dto.active ===
        false
    ) {
      throw new ForbiddenException(
        'No puedes desactivar tu propia cuenta',
      );
    }

    if (
      dto.role !==
        undefined &&
      dto.role !==
        Role.ADMIN
    ) {
      throw new ForbiddenException(
        'No puedes quitarte tu propio rol de administrador',
      );
    }
  }

  private async assertAdminContinuityForUpdate(
    current: {
      id: number;
      role: Role;
      active: boolean;
    },
    dto: UpdateUserDto,
    client:
      PrismaService |
      Prisma.TransactionClient =
        this.prisma,
  ) {
    if (
      current.role !==
        Role.ADMIN ||
      !current.active
    ) {
      return;
    }

    const targetRole =
      dto.role ??
      current.role;

    const targetActive =
      dto.active ??
      current.active;

    if (
      targetRole ===
        Role.ADMIN &&
      targetActive
    ) {
      return;
    }

    const otherActiveAdmins =
      await client.user.count({
        where: {
          id: {
            not:
              current.id,
          },

          role:
            Role.ADMIN,

          active:
            true,
        },
      });

    if (
      otherActiveAdmins ===
      0
    ) {
      throw new ConflictException(
        'No puedes desactivar o degradar al último administrador activo',
      );
    }
  }

  private async assertAdminContinuityForDelete(
    user: {
      id: number;
      role: Role;
      active: boolean;
    },
    client:
      PrismaService |
      Prisma.TransactionClient =
        this.prisma,
  ) {
    if (
      user.role !==
        Role.ADMIN ||
      !user.active
    ) {
      return;
    }

    const otherActiveAdmins =
      await client.user.count({
        where: {
          id: {
            not:
              user.id,
          },

          role:
            Role.ADMIN,

          active:
            true,
        },
      });

    if (
      otherActiveAdmins ===
      0
    ) {
      throw new ConflictException(
        'No puedes eliminar al último administrador activo',
      );
    }
  }

  private toInputJsonValue(
    value: unknown,
  ): Prisma.InputJsonValue {
    return JSON.parse(
      JSON.stringify(
        value,
      ),
    ) as Prisma.InputJsonValue;
  }
}
