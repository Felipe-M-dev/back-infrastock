import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  CredentialScope,
  Prisma,
  Role,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service.js';

import {
  assertActiveCompanyAccessible,
  assertCompanyAccessible,
  buildScopedServerCompanyWhere,
  getAccessibleCompanyIds,
} from '../company-scope/company-scope.js';

import { PrismaService } from '../prisma/prisma.service.js';

import {
  CredentialCryptoService,
} from './credential-crypto.service.js';

import {
  CREDENTIAL_EXPIRING_SOON_DAYS,
  CredentialLifecycleStatus,
} from './credential-lifecycle-status.js';

import {
  AssignCredentialDto,
} from './dto/assign-credential.dto.js';

import {
  CreateCredentialDto,
} from './dto/create-credential.dto.js';

import {
  CredentialQueryDto,
} from './dto/credential-query.dto.js';

import {
  UpdateCredentialDto,
} from './dto/update-credential.dto.js';

export interface CredentialCurrentUser {
  sub: number;
  username: string;
  role: Role;
  companyId: number | null;
}

const SAFE_CREDENTIAL_SELECT =
  Prisma.validator<Prisma.CredentialSelect>()({
    id: true,
    name: true,
    username: true,
    category: true,
    accountType: true,
    environment: true,
    scope: true,
    description: true,
    active: true,
    expiresAt: true,
    lastRotatedAt: true,
    rotationDays: true,
    rotationRequired: true,
    companyId: true,
    company: {
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
      },
    },
    createdById: true,
    updatedById: true,
    createdAt: true,
    updatedAt: true,
  });

@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma:
      PrismaService,

    private readonly auditService:
      AuditService,

    private readonly cryptoService:
      CredentialCryptoService,
  ) {}

  async findAll(
    query: CredentialQueryDto,
    currentUser:
      CredentialCurrentUser,
  ) {
    const accessWhere =
      await this.buildCredentialAccessWhere(
        currentUser,
        query.companyId,
      );

    const search =
      this.normalizeOptionalString(
        query.search,
      );

    const environment =
      this.normalizeOptionalString(
        query.environment,
      );

    const credentials =
      await this.prisma.credential.findMany({
        where: {
          AND: [
            accessWhere,

            query.category
              ? {
                  category:
                    query.category,
                }
              : {},

            query.accountType
              ? {
                  accountType:
                    query.accountType,
                }
              : {},

            query.scope
              ? {
                  scope:
                    query.scope,
                }
              : {},

            query.active ===
            undefined
              ? {}
              : {
                  active:
                    query.active,
                },

            environment
              ? {
                  environment: {
                    equals:
                      environment,
                    mode:
                      'insensitive',
                  },
                }
              : {},

            search
              ? {
                  OR: [
                    {
                      name: {
                        contains:
                          search,
                        mode:
                          'insensitive',
                      },
                    },
                    {
                      username: {
                        contains:
                          search,
                        mode:
                          'insensitive',
                      },
                    },
                    {
                      description: {
                        contains:
                          search,
                        mode:
                          'insensitive',
                      },
                    },
                  ],
                }
              : {},
          ],
        },

        select:
          SAFE_CREDENTIAL_SELECT,

        orderBy: [
          {
            active: 'desc',
          },
          {
            name: 'asc',
          },
          {
            username: 'asc',
          },
        ],
      });

    const result =
      credentials.map((credential) =>
        this.withLifecycle(credential),
      );

    if (!query.lifecycleStatus) {
      return result;
    }

    return result.filter(
      (credential) =>
        credential.lifecycleStatus ===
        query.lifecycleStatus,
    );
  }

  async findOne(
    id: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const credential =
      await this.findAccessibleCredential(
        id,
        currentUser,
        false,
      );

    return this.withLifecycle(
      credential,
    );
  }

  async getUsage(
    id: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const credential =
      await this.findAccessibleCredential(
        id,
        currentUser,
        false,
      );

    const companyWhere =
      await buildScopedServerCompanyWhere(
        this.prisma,
        currentUser,
      );

    const [
      serverAssignments,
      softwareAssignments,
    ] = await Promise.all([
      this.prisma.serverCredential.findMany({
        where: {
          credentialId: id,
          server: companyWhere,
        },

        select: {
          id: true,
          purpose: true,
          createdAt: true,

          server: {
            select: {
              id: true,
              hostname: true,
              ipAddress: true,
              environment: true,
              active: true,
              companyId: true,

              company: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
          },
        },

        orderBy: {
          server: {
            hostname: 'asc',
          },
        },
      }),

      this.prisma.serverSoftwareCredential.findMany({
        where: {
          credentialId: id,

          serverSoftware: {
            server: companyWhere,
          },
        },

        select: {
          id: true,
          purpose: true,
          createdAt: true,

          serverSoftware: {
            select: {
              id: true,
              version: true,

              server: {
                select: {
                  id: true,
                  hostname: true,
                  ipAddress: true,
                  environment: true,
                  active: true,
                  companyId: true,

                  company: {
                    select: {
                      id: true,
                      name: true,
                      slug: true,
                    },
                  },
                },
              },

              software: {
                select: {
                  id: true,
                  name: true,
                  category: true,
                  active: true,
                },
              },
            },
          },
        },

        orderBy: {
          serverSoftware: {
            server: {
              hostname: 'asc',
            },
          },
        },
      }),
    ]);

    return {
      credential:
        this.withLifecycle(
          credential,
        ),

      summary: {
        serverAssignments:
          serverAssignments.length,

        softwareAssignments:
          softwareAssignments.length,

        totalAssignments:
          serverAssignments.length +
          softwareAssignments.length,
      },

      serverAssignments,
      softwareAssignments,
    };
  }

  async create(
    dto: CreateCredentialDto,
    currentUser:
      CredentialCurrentUser,
  ) {
    this.assertAdmin(
      currentUser,
    );

    const scope =
      dto.scope;

    const companyId =
      await this.resolveCompanyForWrite(
        scope,
        dto.companyId,
        currentUser,
      );

    const password =
      this.normalizeRequiredSecret(
        dto.password,
      );

    const encrypted =
      this.cryptoService.encrypt(
        password,
      );

    const credential =
      await this.prisma.credential.create({
        data: {
          name:
            dto.name.trim(),

          username:
            dto.username.trim(),

          encryptedPassword:
            encrypted
              .encryptedPassword,

          iv:
            encrypted.iv,

          authTag:
            encrypted.authTag,

          keyVersion:
            encrypted.keyVersion,

          category:
            dto.category,

          accountType:
            dto.accountType,

          environment:
            this.normalizeOptionalString(
              dto.environment,
            ),

          scope,

          description:
            this.normalizeOptionalString(
              dto.description,
            ),

          active:
            dto.active ??
            true,

          expiresAt:
            this.toOptionalDate(
              dto.expiresAt,
            ),

          lastRotatedAt:
            dto.lastRotatedAt !==
            undefined
              ? this.toOptionalDate(
                  dto.lastRotatedAt,
                )
              : dto.rotationDays
                ? new Date()
                : null,

          rotationDays:
            dto.rotationDays ??
            null,

          rotationRequired:
            dto.rotationRequired ??
            false,

          companyId,

          createdById:
            currentUser.sub,

          updatedById:
            currentUser.sub,
        },

        select:
          SAFE_CREDENTIAL_SELECT,
      });

    await this.auditService.create({
      action:
        'CREATE',

      entityType:
        'CREDENTIAL',

      entityId:
        credential.id,

      entityName:
        credential.name,

      userId:
        currentUser.sub,

      companyId:
        credential.companyId,

      details: {
        message:
          'Credencial creada',

        username:
          credential.username,

        category:
          credential.category,

        accountType:
          credential.accountType,

        environment:
          credential.environment,

        scope:
          credential.scope,

        active:
          credential.active,

        expiresAt:
          credential.expiresAt,

        lastRotatedAt:
          credential.lastRotatedAt,

        rotationDays:
          credential.rotationDays,

        rotationRequired:
          credential.rotationRequired,

        /*
         * Nunca registrar password, encryptedPassword,
         * iv ni authTag en auditoría.
         */
        passwordStored:
          true,

        keyVersion:
          encrypted.keyVersion,
      },
    });

    return this.withLifecycle(
      credential,
    );
  }

  async update(
    id: number,
    dto: UpdateCredentialDto,
    currentUser:
      CredentialCurrentUser,
  ) {
    this.assertAdmin(
      currentUser,
    );

    const existing =
      await this.prisma.credential.findUnique({
        where: {
          id,
        },
      });

    if (!existing) {
      throw new NotFoundException(
        'Credencial no encontrada',
      );
    }

    const targetScope =
      dto.scope ??
      existing.scope;

    const targetCompanyId =
      await this.resolveCompanyForWrite(
        targetScope,
        dto.companyId ??
          existing.companyId ??
          undefined,
        currentUser,
      );

    const targetEnvironment =
      dto.environment !==
      undefined
        ? this.normalizeOptionalString(
            dto.environment,
          )
        : existing.environment;

    await this.assertExistingAssignmentsCompatibleWithCredentialUpdate(
      id,
      targetScope,
      targetCompanyId,
      targetEnvironment,
    );

    const encrypted =
      dto.password !==
      undefined
        ? this.cryptoService.encrypt(
            this.normalizeRequiredSecret(
              dto.password,
            ),
          )
        : null;

    const credential =
      await this.prisma.credential.update({
        where: {
          id,
        },

        data: {
          ...(dto.name !==
          undefined
            ? {
                name:
                  dto.name.trim(),
              }
            : {}),

          ...(dto.username !==
          undefined
            ? {
                username:
                  dto.username.trim(),
              }
            : {}),

          ...(dto.category !==
          undefined
            ? {
                category:
                  dto.category,
              }
            : {}),

          ...(dto.accountType !==
          undefined
            ? {
                accountType:
                  dto.accountType,
              }
            : {}),

          ...(dto.environment !==
          undefined
            ? {
                environment:
                  targetEnvironment,
              }
            : {}),

          ...(dto.scope !==
          undefined
            ? {
                scope:
                  dto.scope,
              }
            : {}),

          ...(dto.description !==
          undefined
            ? {
                description:
                  this.normalizeOptionalString(
                    dto.description,
                  ),
              }
            : {}),

          ...(dto.active !==
          undefined
            ? {
                active:
                  dto.active,
              }
            : {}),

          ...(dto.expiresAt !==
          undefined
            ? {
                expiresAt:
                  this.toOptionalDate(
                    dto.expiresAt,
                  ),
              }
            : {}),

          ...(dto.lastRotatedAt !==
          undefined
            ? {
                lastRotatedAt:
                  this.toOptionalDate(
                    dto.lastRotatedAt,
                  ),
              }
            : {}),

          ...(dto.rotationDays !==
          undefined
            ? {
                rotationDays:
                  dto.rotationDays,
              }
            : {}),

          ...(dto.rotationRequired !==
          undefined
            ? {
                rotationRequired:
                  dto.rotationRequired,
              }
            : {}),

          companyId:
            targetCompanyId,

          ...(encrypted
            ? {
                encryptedPassword:
                  encrypted
                    .encryptedPassword,

                iv:
                  encrypted.iv,

                authTag:
                  encrypted.authTag,

                keyVersion:
                  encrypted
                    .keyVersion,

                lastRotatedAt:
                  new Date(),

                rotationRequired:
                  false,
              }
            : {}),

          updatedById:
            currentUser.sub,
        },

        select:
          SAFE_CREDENTIAL_SELECT,
      });

    await this.auditService.create({
      action:
        'UPDATE',

      entityType:
        'CREDENTIAL',

      entityId:
        credential.id,

      entityName:
        credential.name,

      userId:
        currentUser.sub,

      companyId:
        credential.companyId,

      details: {
        message:
          'Credencial modificada',

        passwordChanged:
          Boolean(
            encrypted,
          ),

        previous: {
          name:
            existing.name,
          username:
            existing.username,
          category:
            existing.category,
          accountType:
            existing.accountType,
          environment:
            existing.environment,
          scope:
            existing.scope,
          companyId:
            existing.companyId,
          description:
            existing.description,
          active:
            existing.active,
          expiresAt:
            existing.expiresAt,
          lastRotatedAt:
            existing.lastRotatedAt,
          rotationDays:
            existing.rotationDays,
          rotationRequired:
            existing.rotationRequired,
        },

        current: {
          name:
            credential.name,
          username:
            credential.username,
          category:
            credential.category,
          accountType:
            credential.accountType,
          environment:
            credential.environment,
          scope:
            credential.scope,
          companyId:
            credential.companyId,
          description:
            credential.description,
          active:
            credential.active,
          expiresAt:
            credential.expiresAt,
          lastRotatedAt:
            credential.lastRotatedAt,
          rotationDays:
            credential.rotationDays,
          rotationRequired:
            credential.rotationRequired,
        },
      },
    });

    return this.withLifecycle(
      credential,
    );
  }

  async deactivate(
    id: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    this.assertAdmin(
      currentUser,
    );

    const existing =
      await this.prisma.credential.findUnique({
        where: {
          id,
        },

        select:
          SAFE_CREDENTIAL_SELECT,
      });

    if (!existing) {
      throw new NotFoundException(
        'Credencial no encontrada',
      );
    }

    if (!existing.active) {
      return this.withLifecycle(
        existing,
      );
    }

    const credential =
      await this.prisma.credential.update({
        where: {
          id,
        },

        data: {
          active: false,
          updatedById:
            currentUser.sub,
        },

        select:
          SAFE_CREDENTIAL_SELECT,
      });

    await this.auditService.create({
      action:
        'DEACTIVATE',

      entityType:
        'CREDENTIAL',

      entityId:
        credential.id,

      entityName:
        credential.name,

      userId:
        currentUser.sub,

      companyId:
        credential.companyId,

      details: {
        message:
          'Credencial desactivada',

        username:
          credential.username,
      },
    });

    return this.withLifecycle(
      credential,
    );
  }

  async copyPassword(
    id: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const credential =
      await this.findAccessibleCredentialForSecret(
        id,
        currentUser,
      );

    if (!credential.active) {
      throw new BadRequestException(
        'La credencial está desactivada',
      );
    }

    const password =
      this.cryptoService.decrypt({
        encryptedPassword:
          credential
            .encryptedPassword,

        iv:
          credential.iv,

        authTag:
          credential.authTag,

        keyVersion:
          credential.keyVersion,
      });

    await this.auditService.create({
      action:
        'PASSWORD_COPIED',

      entityType:
        'CREDENTIAL',

      entityId:
        credential.id,

      entityName:
        credential.name,

      userId:
        currentUser.sub,

      companyId:
        credential.companyId,

      details: {
        message:
          'Password copied',

        username:
          credential.username,

        /*
         * La contraseña y sus materiales criptográficos
         * nunca se incluyen en el evento.
         */
        passwordReturned:
          true,
      },
    });

    return {
      password,
    };
  }

  async listServerAssignments(
    serverId: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const server =
      await this.getAccessibleServer(
        serverId,
        currentUser,
      );

    return this.prisma.serverCredential.findMany({
      where: {
        serverId:
          server.id,
      },

      select: {
        id: true,
        purpose: true,
        createdAt: true,
        credential: {
          select:
            SAFE_CREDENTIAL_SELECT,
        },
      },

      orderBy: {
        credential: {
          name: 'asc',
        },
      },
    });
  }

  async assignToServer(
    serverId: number,
    dto: AssignCredentialDto,
    currentUser:
      CredentialCurrentUser,
  ) {
    const server =
      await this.getAccessibleServer(
        serverId,
        currentUser,
      );

    const credential =
      await this.findAccessibleCredential(
        dto.credentialId,
        currentUser,
        true,
      );

    this.assertCredentialCanBeAssignedToServer(
      credential,
      server,
    );

    try {
      const assignment =
        await this.prisma.serverCredential.create({
          data: {
            serverId:
              server.id,

            credentialId:
              credential.id,

            purpose:
              this.normalizeOptionalString(
                dto.purpose,
              ),

            createdById:
              currentUser.sub,
          },

          select: {
            id: true,
            purpose: true,
            createdAt: true,
            credential: {
              select:
                SAFE_CREDENTIAL_SELECT,
            },
          },
        });

      await this.auditService.create({
        action:
          'CREDENTIAL_ASSIGNED',

        entityType:
          'SERVER',

        entityId:
          server.id,

        entityName:
          server.hostname,

        userId:
          currentUser.sub,

        companyId:
          server.companyId,

        details: {
          message:
            'Credencial asignada al servidor',

          credentialId:
            credential.id,

          credentialName:
            credential.name,

          username:
            credential.username,

          purpose:
            assignment.purpose,
        },
      });

      return assignment;
    } catch (error) {
      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code ===
          'P2002'
      ) {
        throw new ConflictException(
          'La credencial ya está asignada a este servidor',
        );
      }

      throw error;
    }
  }

  async unassignFromServer(
    serverId: number,
    credentialId: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const server =
      await this.getAccessibleServer(
        serverId,
        currentUser,
      );

    const assignment =
      await this.prisma.serverCredential.findUnique({
        where: {
          serverId_credentialId: {
            serverId:
              server.id,

            credentialId,
          },
        },

        include: {
          credential: {
            select: {
              id: true,
              name: true,
              username: true,
            },
          },
        },
      });

    if (!assignment) {
      throw new NotFoundException(
        'La credencial no está asignada a este servidor',
      );
    }

    await this.prisma.serverCredential.delete({
      where: {
        id:
          assignment.id,
      },
    });

    await this.auditService.create({
      action:
        'CREDENTIAL_UNASSIGNED',

      entityType:
        'SERVER',

      entityId:
        server.id,

      entityName:
        server.hostname,

      userId:
        currentUser.sub,

      companyId:
        server.companyId,

      details: {
        message:
          'Credencial desvinculada del servidor',

        credentialId:
          assignment
            .credential.id,

        credentialName:
          assignment
            .credential.name,

        username:
          assignment
            .credential.username,

        purpose:
          assignment.purpose,
      },
    });

    return {
      message:
        'Credencial desvinculada del servidor',
    };
  }

  async listServerSoftwareAssignments(
    serverSoftwareId: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const context =
      await this.getAccessibleServerSoftware(
        serverSoftwareId,
        currentUser,
      );

    return this.prisma.serverSoftwareCredential.findMany({
      where: {
        serverSoftwareId:
          context.serverSoftware.id,
      },

      select: {
        id: true,
        purpose: true,
        createdAt: true,
        credential: {
          select:
            SAFE_CREDENTIAL_SELECT,
        },
      },

      orderBy: {
        credential: {
          name: 'asc',
        },
      },
    });
  }

  async assignToServerSoftware(
    serverSoftwareId: number,
    dto: AssignCredentialDto,
    currentUser:
      CredentialCurrentUser,
  ) {
    const context =
      await this.getAccessibleServerSoftware(
        serverSoftwareId,
        currentUser,
      );

    const credential =
      await this.findAccessibleCredential(
        dto.credentialId,
        currentUser,
        true,
      );

    this.assertCredentialCanBeAssignedToSoftware(
      credential,
      context.serverSoftware.server,
    );

    try {
      const assignment =
        await this.prisma.serverSoftwareCredential.create({
          data: {
            serverSoftwareId:
              context.serverSoftware.id,

            credentialId:
              credential.id,

            purpose:
              this.normalizeOptionalString(
                dto.purpose,
              ),

            createdById:
              currentUser.sub,
          },

          select: {
            id: true,
            purpose: true,
            createdAt: true,
            credential: {
              select:
                SAFE_CREDENTIAL_SELECT,
            },
          },
        });

      await this.auditService.create({
        action:
          'CREDENTIAL_ASSIGNED',

        entityType:
          'SERVER_SOFTWARE',

        entityId:
          context.serverSoftware.id,

        entityName:
          `${context.serverSoftware.server.hostname} / ${context.serverSoftware.software.name}`,

        userId:
          currentUser.sub,

        companyId:
          context.serverSoftware.server.companyId,

        details: {
          message:
            'Credencial asignada al software del servidor',

          serverId:
            context.serverSoftware.server.id,

          hostname:
            context.serverSoftware.server.hostname,

          softwareId:
            context.serverSoftware.software.id,

          softwareName:
            context.serverSoftware.software.name,

          credentialId:
            credential.id,

          credentialName:
            credential.name,

          username:
            credential.username,

          purpose:
            assignment.purpose,
        },
      });

      return assignment;
    } catch (error) {
      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code ===
          'P2002'
      ) {
        throw new ConflictException(
          'La credencial ya está asignada a este software',
        );
      }

      throw error;
    }
  }

  async unassignFromServerSoftware(
    serverSoftwareId: number,
    credentialId: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const context =
      await this.getAccessibleServerSoftware(
        serverSoftwareId,
        currentUser,
      );

    const assignment =
      await this.prisma.serverSoftwareCredential.findUnique({
        where: {
          serverSoftwareId_credentialId: {
            serverSoftwareId:
              context.serverSoftware.id,

            credentialId,
          },
        },

        include: {
          credential: {
            select: {
              id: true,
              name: true,
              username: true,
            },
          },
        },
      });

    if (!assignment) {
      throw new NotFoundException(
        'La credencial no está asignada a este software',
      );
    }

    await this.prisma.serverSoftwareCredential.delete({
      where: {
        id:
          assignment.id,
      },
    });

    await this.auditService.create({
      action:
        'CREDENTIAL_UNASSIGNED',

      entityType:
        'SERVER_SOFTWARE',

      entityId:
        context.serverSoftware.id,

      entityName:
        `${context.serverSoftware.server.hostname} / ${context.serverSoftware.software.name}`,

      userId:
        currentUser.sub,

      companyId:
        context.serverSoftware.server.companyId,

      details: {
        message:
          'Credencial desvinculada del software del servidor',

        serverId:
          context.serverSoftware.server.id,

        hostname:
          context.serverSoftware.server.hostname,

        softwareId:
          context.serverSoftware.software.id,

        softwareName:
          context.serverSoftware.software.name,

        credentialId:
          assignment
            .credential.id,

        credentialName:
          assignment
            .credential.name,

        username:
          assignment
            .credential.username,

        purpose:
          assignment.purpose,
      },
    });

    return {
      message:
        'Credencial desvinculada del software',
    };
  }

  private async findAccessibleCredential(
    id: number,
    currentUser:
      CredentialCurrentUser,
    requireActive: boolean,
  ) {
    const accessWhere =
      await this.buildCredentialAccessWhere(
        currentUser,
      );

    const credential =
      await this.prisma.credential.findFirst({
        where: {
          AND: [
            {
              id,
            },
            accessWhere,
            requireActive
              ? {
                  active:
                    true,
                }
              : {},
          ],
        },

        select:
          SAFE_CREDENTIAL_SELECT,
      });

    if (!credential) {
      throw new NotFoundException(
        'Credencial no encontrada',
      );
    }

    return credential;
  }

  private async findAccessibleCredentialForSecret(
    id: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const accessWhere =
      await this.buildCredentialAccessWhere(
        currentUser,
      );

    const credential =
      await this.prisma.credential.findFirst({
        where: {
          AND: [
            {
              id,
            },
            accessWhere,
          ],
        },

        select: {
          id: true,
          name: true,
          username: true,
          encryptedPassword:
            true,
          iv: true,
          authTag: true,
          keyVersion: true,
          active: true,
          companyId: true,
          scope: true,
        },
      });

    if (!credential) {
      throw new NotFoundException(
        'Credencial no encontrada',
      );
    }

    return credential;
  }

  private async buildCredentialAccessWhere(
    currentUser:
      CredentialCurrentUser,
    requestedCompanyId?: number,
  ): Promise<Prisma.CredentialWhereInput> {
    if (
      requestedCompanyId !==
      undefined
    ) {
      await assertCompanyAccessible(
        this.prisma,
        currentUser,
        requestedCompanyId,
      );

      /*
       * Al filtrar una empresa mostramos tanto sus credenciales
       * propias como las credenciales GLOBAL creadas
       * explícitamente para uso transversal.
       */
      return {
        OR: [
          {
            companyId:
              requestedCompanyId,
          },
          {
            scope:
              CredentialScope.GLOBAL,
            companyId:
              null,
          },
        ],
      };
    }

    if (
      currentUser.role ===
      Role.ADMIN
    ) {
      return {};
    }

    const companyIds =
      await getAccessibleCompanyIds(
        this.prisma,
        currentUser,
      );

    return {
      OR: [
        {
          scope:
            CredentialScope.GLOBAL,
          companyId:
            null,
        },

        {
          companyId: {
            in:
              companyIds ??
              [],
          },
        },
      ],
    };
  }

  private async resolveCompanyForWrite(
    scope: CredentialScope,
    companyId:
      number | undefined,
    currentUser:
      CredentialCurrentUser,
  ): Promise<number | null> {
    if (
      scope ===
      CredentialScope.GLOBAL
    ) {
      return null;
    }

    if (!companyId) {
      throw new BadRequestException(
        'companyId es obligatorio para credenciales que no sean GLOBAL',
      );
    }

    await assertActiveCompanyAccessible(
      this.prisma,
      currentUser,
      companyId,
    );

    return companyId;
  }

  private async assertExistingAssignmentsCompatibleWithCredentialUpdate(
    credentialId: number,
    targetScope: CredentialScope,
    targetCompanyId: number | null,
    targetEnvironment: string | null,
  ) {
    const [
      serverAssignments,
      softwareAssignments,
    ] = await Promise.all([
      this.prisma.serverCredential.findMany({
        where: {
          credentialId,
        },

        select: {
          server: {
            select: {
              id: true,
              hostname: true,
              companyId: true,
              environment: true,
            },
          },
        },
      }),

      this.prisma.serverSoftwareCredential.findMany({
        where: {
          credentialId,
        },

        select: {
          serverSoftware: {
            select: {
              id: true,

              server: {
                select: {
                  id: true,
                  hostname: true,
                  companyId: true,
                  environment: true,
                },
              },

              software: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const conflicts:
      string[] = [];

    for (
      const assignment
      of serverAssignments
    ) {
      const server =
        assignment.server;

      if (
        targetScope ===
        CredentialScope.SOFTWARE
      ) {
        conflicts.push(
          `Servidor ${server.hostname}: el alcance SOFTWARE no permite asignación directa al servidor`,
        );

        continue;
      }

      if (
        this.hasCompanyCompatibilityConflict(
          targetScope,
          targetCompanyId,
          server.companyId,
        )
      ) {
        conflicts.push(
          `Servidor ${server.hostname}: la empresa de la credencial no coincide con la empresa del servidor`,
        );

        continue;
      }

      if (
        this.hasEnvironmentCompatibilityConflict(
          targetEnvironment,
          server.environment,
        )
      ) {
        conflicts.push(
          `Servidor ${server.hostname}: el ambiente de la credencial no coincide con el ambiente ${server.environment ?? 'sin definir'} del servidor`,
        );
      }
    }

    for (
      const assignment
      of softwareAssignments
    ) {
      const serverSoftware =
        assignment.serverSoftware;

      const server =
        serverSoftware.server;

      if (
        targetScope ===
        CredentialScope.SERVER
      ) {
        conflicts.push(
          `${server.hostname} / ${serverSoftware.software.name}: el alcance SERVER no permite asignación directa al software`,
        );

        continue;
      }

      if (
        this.hasCompanyCompatibilityConflict(
          targetScope,
          targetCompanyId,
          server.companyId,
        )
      ) {
        conflicts.push(
          `${server.hostname} / ${serverSoftware.software.name}: la empresa de la credencial no coincide con la empresa del servidor`,
        );

        continue;
      }

      if (
        this.hasEnvironmentCompatibilityConflict(
          targetEnvironment,
          server.environment,
        )
      ) {
        conflicts.push(
          `${server.hostname} / ${serverSoftware.software.name}: el ambiente de la credencial no coincide con el ambiente ${server.environment ?? 'sin definir'} del servidor`,
        );
      }
    }

    if (
      conflicts.length ===
      0
    ) {
      return;
    }

    const visibleConflicts =
      conflicts.slice(
        0,
        5,
      );

    const remaining =
      conflicts.length -
      visibleConflicts.length;

    const suffix =
      remaining > 0
        ? ` Se detectaron ${remaining} conflicto(s) adicional(es).`
        : '';

    throw new BadRequestException(
      `No se puede modificar la empresa, el alcance o el ambiente de la credencial porque existen asignaciones incompatibles. Desvincule primero las asignaciones afectadas. ${visibleConflicts.join(' | ')}${suffix}`,
    );
  }

  private hasCompanyCompatibilityConflict(
    scope: CredentialScope,
    credentialCompanyId:
      number | null,
    serverCompanyId:
      number | null,
  ) {
    if (
      scope ===
      CredentialScope.GLOBAL
    ) {
      return false;
    }

    return (
      !credentialCompanyId ||
      !serverCompanyId ||
      credentialCompanyId !==
        serverCompanyId
    );
  }

  private hasEnvironmentCompatibilityConflict(
    credentialEnvironment:
      string | null,
    serverEnvironment:
      string | null,
  ) {
    if (
      !credentialEnvironment
    ) {
      return false;
    }

    return (
      credentialEnvironment
        .trim()
        .toUpperCase() !==
      (
        serverEnvironment
          ?.trim()
          .toUpperCase() ??
        ''
      )
    );
  }

  private async getAccessibleServer(
    serverId: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const companyWhere =
      await buildScopedServerCompanyWhere(
        this.prisma,
        currentUser,
      );

    const server =
      await this.prisma.server.findFirst({
        where: {
          AND: [
            {
              id:
                serverId,
            },
            companyWhere,
          ],
        },

        select: {
          id: true,
          hostname: true,
          environment: true,
          companyId: true,
        },
      });

    if (!server) {
      throw new NotFoundException(
        'Servidor no encontrado',
      );
    }

    return server;
  }

  private async getAccessibleServerSoftware(
    serverSoftwareId: number,
    currentUser:
      CredentialCurrentUser,
  ) {
    const companyWhere =
      await buildScopedServerCompanyWhere(
        this.prisma,
        currentUser,
      );

    const serverSoftware =
      await this.prisma.serverSoftware.findFirst({
        where: {
          id:
            serverSoftwareId,

          server:
            companyWhere,
        },

        select: {
          id: true,

          server: {
            select: {
              id: true,
              hostname: true,
              environment: true,
              companyId: true,
            },
          },

          software: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

    if (!serverSoftware) {
      throw new NotFoundException(
        'Software del servidor no encontrado',
      );
    }

    return {
      serverSoftware,
    };
  }

  private assertCredentialCanBeAssignedToServer(
    credential: {
      id: number;
      name: string;
      companyId: number | null;
      environment: string | null;
      scope: CredentialScope;
      active: boolean;
    },
    server: {
      id: number;
      hostname: string;
      companyId: number | null;
      environment: string | null;
    },
  ) {
    if (!credential.active) {
      throw new BadRequestException(
        'La credencial está desactivada',
      );
    }

    if (
      credential.scope ===
      CredentialScope.SOFTWARE
    ) {
      throw new BadRequestException(
        'Una credencial con alcance SOFTWARE no puede asignarse directamente al servidor',
      );
    }

    this.assertCompanyCompatibility(
      credential,
      server,
    );

    this.assertEnvironmentCompatibility(
      credential.environment,
      server.environment,
    );
  }

  private assertCredentialCanBeAssignedToSoftware(
    credential: {
      id: number;
      name: string;
      companyId: number | null;
      environment: string | null;
      scope: CredentialScope;
      active: boolean;
    },
    server: {
      id: number;
      hostname: string;
      companyId: number | null;
      environment: string | null;
    },
  ) {
    if (!credential.active) {
      throw new BadRequestException(
        'La credencial está desactivada',
      );
    }

    if (
      credential.scope ===
      CredentialScope.SERVER
    ) {
      throw new BadRequestException(
        'Una credencial con alcance SERVER no puede asignarse directamente a un software',
      );
    }

    this.assertCompanyCompatibility(
      credential,
      server,
    );

    this.assertEnvironmentCompatibility(
      credential.environment,
      server.environment,
    );
  }

  private assertCompanyCompatibility(
    credential: {
      companyId: number | null;
      scope: CredentialScope;
    },
    server: {
      companyId: number | null;
    },
  ) {
    if (
      credential.scope ===
      CredentialScope.GLOBAL
    ) {
      return;
    }

    if (
      this.hasCompanyCompatibilityConflict(
        credential.scope,
        credential.companyId,
        server.companyId,
      )
    ) {
      throw new ForbiddenException(
        'La credencial no pertenece a la misma empresa del servidor',
      );
    }
  }

  private assertEnvironmentCompatibility(
    credentialEnvironment:
      string | null,
    serverEnvironment:
      string | null,
  ) {
    if (
      this.hasEnvironmentCompatibilityConflict(
        credentialEnvironment,
        serverEnvironment,
      )
    ) {
      throw new BadRequestException(
        `La credencial corresponde al ambiente ${credentialEnvironment} y el servidor al ambiente ${serverEnvironment ?? 'sin definir'}`,
      );
    }
  }

  private withLifecycle<
    T extends {
      expiresAt: Date | null;
      lastRotatedAt: Date | null;
      rotationDays: number | null;
      rotationRequired: boolean;
    },
  >(credential: T) {
    const now =
      new Date();

    const nextRotationAt =
      credential.rotationDays &&
      credential.lastRotatedAt
        ? new Date(
            credential.lastRotatedAt.getTime() +
              credential.rotationDays *
                24 *
                60 *
                60 *
                1000,
          )
        : null;

    const daysUntilExpiry =
      credential.expiresAt
        ? Math.ceil(
            (credential.expiresAt.getTime() -
              now.getTime()) /
              (24 * 60 * 60 * 1000),
          )
        : null;

    let lifecycleStatus:
      CredentialLifecycleStatus;

    if (
      credential.expiresAt &&
      credential.expiresAt.getTime() <
        now.getTime()
    ) {
      lifecycleStatus =
        CredentialLifecycleStatus.EXPIRED;
    } else if (
      credential.rotationRequired ||
      (
        credential.rotationDays !==
          null &&
        (
          !credential.lastRotatedAt ||
          (
            nextRotationAt !== null &&
            nextRotationAt.getTime() <=
              now.getTime()
          )
        )
      )
    ) {
      lifecycleStatus =
        CredentialLifecycleStatus.ROTATION_REQUIRED;
    } else if (
      credential.expiresAt &&
      daysUntilExpiry !== null &&
      daysUntilExpiry <=
        CREDENTIAL_EXPIRING_SOON_DAYS
    ) {
      lifecycleStatus =
        CredentialLifecycleStatus.EXPIRING_SOON;
    } else if (
      !credential.expiresAt &&
      credential.rotationDays ===
        null &&
      !credential.rotationRequired
    ) {
      lifecycleStatus =
        CredentialLifecycleStatus.WITHOUT_POLICY;
    } else {
      lifecycleStatus =
        CredentialLifecycleStatus.VALID;
    }

    return {
      ...credential,
      lifecycleStatus,
      nextRotationAt,
      daysUntilExpiry,
    };
  }

  private toOptionalDate(
    value:
      string | null | undefined,
  ): Date | null {
    if (
      value === undefined ||
      value === null ||
      value.trim() === ''
    ) {
      return null;
    }

    const date =
      new Date(value);

    if (
      Number.isNaN(
        date.getTime(),
      )
    ) {
      throw new BadRequestException(
        'Fecha de credencial inválida',
      );
    }

    return date;
  }

  private assertAdmin(
    currentUser:
      CredentialCurrentUser,
  ) {
    if (
      currentUser.role !==
      Role.ADMIN
    ) {
      throw new ForbiddenException(
        'Solo un administrador puede administrar la bóveda de credenciales',
      );
    }
  }

  private normalizeOptionalString(
    value:
      string | undefined | null,
  ): string | null {
    if (
      value === undefined ||
      value === null
    ) {
      return null;
    }

    const normalized =
      value.trim();

    return normalized.length > 0
      ? normalized
      : null;
  }

  private normalizeRequiredSecret(
    value: string,
  ): string {
    /*
     * No usamos trim() sobre contraseñas.
     * Los espacios pueden formar parte legítima del secreto.
     */
    if (
      value.length ===
      0
    ) {
      throw new BadRequestException(
        'La contraseña no puede estar vacía',
      );
    }

    return value;
  }
}
