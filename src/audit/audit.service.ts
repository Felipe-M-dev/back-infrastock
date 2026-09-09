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
  assertCompanyAccessible,
} from '../company-scope/company-scope.js';

import { PrismaService } from '../prisma/prisma.service.js';

interface CurrentUser {
  sub: number;
  username: string;
  role: Role;
  companyId: number | null;
}

interface CreateAuditLogInput {
  action: string;
  entityType: string;
  entityId?: number | null;
  entityName?: string | null;
  details?: unknown;
  userId?: number | null;
  companyId?: number | null;
}

interface StoredAuditChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
  beforeValue: unknown;
  afterValue: unknown;
}

interface ServerSoftwareValue {
  softwareId: number;
  version: string;
  notes: string | null;
}


export interface AuditIntegrityStatus {
  valid: boolean;
  totalRows: number;
  firstInvalidId: number | null;
  reason: string | null;
  verifiedAt: Date;
}

export interface RevertPreviewChange {
  field: string;
  label: string;
  currentValue: unknown;
  currentDisplay: unknown;
  recordedAfterValue: unknown;
  targetValue: unknown;
  targetDisplay: unknown;
  changedAfterEvent: boolean;
  warning: string | null;
}

export interface RevertPreviewResponse {
  auditLogId: number;
  entityType: string;
  entityId: number | null;
  entityName: string | null;
  sourceAction: string;
  sourceCreatedAt: Date;

  sourceUser: {
    id: number;
    username: string;
    name: string;
  } | null;

  server: {
    id: number;
    hostname: string;
    companyId: number | null;

    company: {
      id: number;
      name: string;
      slug: string;
      logoUrl: string | null;
      primaryColor: string;
      secondaryColor: string;
      backgroundColor: string;
      surfaceColor: string;
      textColor: string;
      active: boolean;
      createdById: number | null;
      updatedById: number | null;
      createdAt: Date;
      updatedAt: Date;
    } | null;
  };

  reversible: boolean;
  hasLaterChanges: boolean;
  changes: RevertPreviewChange[];
}

const REVERSIBLE_SERVER_FIELDS =
  new Set([
    'hostname',
    'ipAddress',
    'environment',
    'cpuCores',
    'ramGb',
    'diskGb',
    'notes',
    'active',
    'servicesOnitec',
    'companyId',
    'operatingSystemId',
    'software',
  ]);

/*
 * Estas entidades son catálogos globales de InfraStock.
 * Sus AuditLog se almacenan intencionalmente con companyId = null.
 *
 * El AuditController ya determina qué roles pueden consultar cada
 * entityType. Por eso, una vez autorizado el acceso al historial de
 * una entidad global, no corresponde volver a restringirlo por la
 * empresa del usuario.
 *
 * CREDENTIAL y SERVER_SOFTWARE NO se incluyen aquí porque requieren
 * mantener su alcance por empresa.
 */
const GLOBAL_AUDIT_ENTITY_TYPES =
  new Set([
    'OPERATING_SYSTEM',
    'SOFTWARE',
    'PRICING_TARIFF',
    'ECONOMIC_INDICATOR',
  ]);

const AUDIT_HISTORY_LIMIT = 250;

const SENSITIVE_AUDIT_KEY_PATTERN =
  /^(password|passwordHash|currentPassword|secret|token|accessToken|refreshToken|authorization|cookie|apiKey|clientSecret|privateKey|ciphertext|encryptedPassword|encryptedSecret)$/i;

const SENSITIVE_AUDIT_FIELD_PATTERN =
  /(password|contrase(?:n|ñ)a|secret|token|api.?key|client.?secret|private.?key|ciphertext|encrypted.?password|encrypted.?secret)/i;

const REDACTED_AUDIT_VALUE = '[REDACTED]';

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  create(
    input: CreateAuditLogInput,
  ) {
    return this.prisma.auditLog.create({
      data: {
        action:
          input.action,

        entityType:
          input.entityType,

        entityId:
          input.entityId ??
          null,

        entityName:
          input.entityName ??
          null,

        details:
          input.details ===
          undefined
            ? undefined
            : this.toInputJsonValue(
                this.sanitizeAuditValue(
                  input.details,
                ),
              ),

        userId:
          input.userId ??
          null,

        companyId:
          input.companyId ??
          null,
      },
    });
  }


  async verifyIntegrity(): Promise<AuditIntegrityStatus> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        valid: boolean;
        totalRows: bigint;
        firstInvalidId: number | null;
        reason: string | null;
      }>
    >(Prisma.sql`SELECT * FROM verify_audit_log_integrity()`);

    const result = rows[0];

    if (!result) {
      return {
        valid: true,
        totalRows: 0,
        firstInvalidId: null,
        reason: null,
        verifiedAt: new Date(),
      };
    }

    return {
      valid: result.valid,
      totalRows: Number(result.totalRows),
      firstInvalidId: result.firstInvalidId,
      reason: result.reason,
      verifiedAt: new Date(),
    };
  }

  async findHistory(
    entityType: string,
    entityId: number,
    currentUser: CurrentUser,
  ) {
    const normalizedEntityType =
      entityType
        .trim()
        .toUpperCase();

    if (
      !normalizedEntityType
    ) {
      throw new BadRequestException(
        'Tipo de entidad inválido',
      );
    }

    await this.assertHistoryEntityAccess(
      normalizedEntityType,
      entityId,
      currentUser,
    );

    const where:
      Prisma.AuditLogWhereInput = {
      entityType:
        normalizedEntityType,

      entityId,
    };

    /*
     * SERVER valida acceso contra el servidor real y sus empresas
     * accesibles.
     *
     * Los catálogos globales guardan companyId = null y el controller
     * ya valida el rol permitido para cada entityType, por lo que no
     * deben filtrarse por la empresa del EDITOR.
     *
     * Las demás entidades continúan siendo company-scoped para
     * usuarios no ADMIN.
     */
    if (
      normalizedEntityType !==
        'SERVER' &&
      !GLOBAL_AUDIT_ENTITY_TYPES.has(
        normalizedEntityType,
      ) &&
      currentUser.role !==
        Role.ADMIN
    ) {
      where.companyId =
        currentUser.companyId ??
        -1;
    }

    const rows =
      await this.prisma.auditLog.findMany({
        where,

        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          entityName: true,
          details: true,
          userId: true,
          companyId: true,
          createdAt: true,

          user: {
            select: {
              id: true,
              username: true,
              name: true,
            },
          },

          company: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },

        orderBy: [
          {
            createdAt: 'desc',
          },
          {
            id: 'desc',
          },
        ],

        take: AUDIT_HISTORY_LIMIT,
      });

    return rows.map(
      (row) => ({
        ...row,
        details:
          this.sanitizeAuditValue(
            row.details,
          ),
      }),
    );
  }

  async getRevertPreview(
    auditLogId: number,
    currentUser: CurrentUser,
  ): Promise<RevertPreviewResponse> {
    const context =
      await this.getRevertContext(
        auditLogId,
        currentUser,
      );

    const previewChanges =
      await this.buildPreviewChanges(
        context.server,
        context.changes,
      );

    return {
      auditLogId:
        context.auditLog.id,

      entityType:
        context.auditLog.entityType,

      entityId:
        context.auditLog.entityId,

      entityName:
        context.auditLog.entityName,

      sourceAction:
        context.auditLog.action,

      sourceCreatedAt:
        context.auditLog.createdAt,

      sourceUser:
        context.auditLog.user,

      server: {
        id:
          context.server.id,

        hostname:
          context.server.hostname,

        companyId:
          context.server.companyId,

        company:
          context.server.company,
      },

      reversible:
        true,

      hasLaterChanges:
        previewChanges.some(
          (change) =>
            change.changedAfterEvent,
        ),

      changes:
        previewChanges,
    };
  }

  async revert(
    auditLogId: number,
    currentUser: CurrentUser,
  ) {
    const context =
      await this.getRevertContext(
        auditLogId,
        currentUser,
      );

    const previewChanges =
      await this.buildPreviewChanges(
        context.server,
        context.changes,
      );

    if (
      previewChanges.some(
        (change) =>
          change.changedAfterEvent,
      )
    ) {
      throw new ConflictException(
        'No es posible revertir este evento porque el servidor fue modificado posteriormente. Revierte primero los cambios más recientes.',
      );
    }

    await this.validateRevertTargets(
      context.server.id,
      context.changes,
      currentUser,
    );

    const updateData:
      Prisma.ServerUpdateInput = {
      updatedBy: {
        connect: {
          id:
            currentUser.sub,
        },
      },
    };

    let softwareTarget:
      ServerSoftwareValue[] |
      undefined;

    for (
      const change
      of context.changes
    ) {
      switch (
        change.field
      ) {
        case 'hostname':
          updateData.hostname =
            this.readNullableStringAsRequired(
              change.beforeValue,
              'Hostname anterior inválido',
            );
          break;

        case 'ipAddress':
          updateData.ipAddress =
            this.readNullableString(
              change.beforeValue,
              'IP anterior inválida',
            );
          break;

        case 'environment':
          updateData.environment =
            this.readNullableString(
              change.beforeValue,
              'Ambiente anterior inválido',
            );
          break;

        case 'cpuCores':
          updateData.cpuCores =
            this.readNullableInteger(
              change.beforeValue,
              'CPU anterior inválida',
            );
          break;

        case 'ramGb':
          updateData.ramGb =
            this.readNullableInteger(
              change.beforeValue,
              'RAM anterior inválida',
            );
          break;

        case 'diskGb':
          updateData.diskGb =
            this.readNullableInteger(
              change.beforeValue,
              'Disco anterior inválido',
            );
          break;

        case 'notes':
          updateData.notes =
            this.readNullableString(
              change.beforeValue,
              'Notas anteriores inválidas',
            );
          break;

        case 'active':
          updateData.active =
            this.readBoolean(
              change.beforeValue,
              'Estado anterior inválido',
            );
          break;

        case 'servicesOnitec':
          updateData.servicesOnitec =
            this.readBoolean(
              change.beforeValue,
              'Configuración anterior de Servicios Onitec inválida',
            );
          break;

        case 'companyId': {
          const targetCompanyId =
            this.readNullableInteger(
              change.beforeValue,
              'Empresa anterior inválida',
            );

          updateData.company =
            targetCompanyId ===
            null
              ? {
                  disconnect:
                    true,
                }
              : {
                  connect: {
                    id:
                      targetCompanyId,
                  },
                };

          break;
        }

        case 'operatingSystemId': {
          const targetOperatingSystemId =
            this.readNullableInteger(
              change.beforeValue,
              'Sistema operativo anterior inválido',
            );

          updateData.operatingSystem =
            targetOperatingSystemId ===
            null
              ? {
                  disconnect:
                    true,
                }
              : {
                  connect: {
                    id:
                      targetOperatingSystemId,
                  },
                };

          break;
        }

        case 'software':
          softwareTarget =
            this.readSoftwareValue(
              change.beforeValue,
            );

          updateData.software = {
            deleteMany:
              {},

            create:
              softwareTarget.map(
                (item) => ({
                  software: {
                    connect: {
                      id:
                        item.softwareId,
                    },
                  },

                  version:
                    item.version,

                  notes:
                    item.notes,
                }),
              ),
          };
          break;

        default:
          throw new BadRequestException(
            `El campo ${change.field} no admite reversión`,
          );
      }
    }

    const revertAuditChanges =
      previewChanges.map(
        (
          previewChange,
          index,
        ) => {
          const sourceChange =
            context.changes[
              index
            ];

          return {
            field:
              sourceChange.field,

            label:
              sourceChange.label,

            before:
              previewChange.currentDisplay,

            after:
              sourceChange.before,

            beforeValue:
              previewChange.currentValue,

            afterValue:
              sourceChange.beforeValue,
          };
        },
      );

    try {
      /*
       * UPDATE del servidor + AuditLog REVERT deben ser
       * atómicos: o se confirman ambos o ninguno.
       *
       * Usamos una transacción interactiva SERIALIZABLE y
       * mantenemos todas las consultas estrictamente
       * secuenciales. El UPDATE sigue siendo mínimo y sin
       * include para evitar el warning de pg que ya
       * corregimos anteriormente.
       *
       * Además repetimos dentro de la transacción la
       * validación "evento ya revertido". Esto evita que dos
       * solicitudes concurrentes puedan revertir el mismo
       * UPDATE al mismo tiempo.
       */
      const transactionResult =
        await this.prisma.$transaction(
          async (
            tx,
          ) => {
            const liveServer =
              await tx.server.findUnique({
                where: {
                  id:
                    context.server.id,
                },
                include:
                  this.getServerInclude(),
              });

            if (!liveServer) {
              throw new ConflictException(
                'El servidor cambió o dejó de existir antes de completar la reversión. Actualiza el historial e inténtalo nuevamente.',
              );
            }

            if (
              liveServer.companyId !==
              context.server.companyId
            ) {
              throw new ConflictException(
                'El servidor cambió de empresa antes de completar la reversión. Actualiza el historial e inténtalo nuevamente.',
              );
            }

            for (
              const previewChange
              of previewChanges
            ) {
              const liveValue =
                this.getCurrentValue(
                  liveServer,
                  previewChange.field,
                );

              if (
                !this.valuesEqual(
                  liveValue,
                  previewChange.currentValue,
                  previewChange.field,
                )
              ) {
                throw new ConflictException(
                  'El servidor fue modificado mientras se procesaba la reversión. Actualiza el historial e inténtalo nuevamente.',
                );
              }
            }

            const revertEvents =
              await tx.auditLog.findMany({
                where: {
                  action:
                    'REVERT',

                  entityType:
                    'SERVER',

                  entityId:
                    context.server.id,
                },

                select: {
                  id:
                    true,

                  details:
                    true,
                },

                orderBy: {
                  createdAt:
                    'desc',
                },
              });

            for (
              const event
              of revertEvents
            ) {
              if (
                !event.details ||
                typeof event.details !==
                  'object' ||
                Array.isArray(
                  event.details,
                )
              ) {
                continue;
              }

              const details =
                event.details as
                  Prisma.JsonObject;

              if (
                details[
                  'sourceAuditLogId'
                ] ===
                context.auditLog.id
              ) {
                throw new ConflictException(
                  `El evento #${context.auditLog.id} ya fue revertido por el evento #${event.id}`,
                );
              }
            }

            const updatedServer =
              await tx.server.update({
                where: {
                  id:
                    context.server.id,
                },

                data:
                  updateData,
              });

            const revertAuditLog =
              await tx.auditLog.create({
                data: {
                  action:
                    'REVERT',

                  entityType:
                    'SERVER',

                  entityId:
                    updatedServer.id,

                  entityName:
                    updatedServer.hostname,

                  userId:
                    currentUser.sub,

                  companyId:
                    updatedServer.companyId,

                  details:
                    this.toInputJsonValue(
                      this.sanitizeAuditValue({
                        message:
                          'Cambio revertido',

                        sourceAuditLogId:
                          context.auditLog.id,

                        fields:
                          revertAuditChanges.map(
                            (change) =>
                              change.field,
                          ),

                        changes:
                          revertAuditChanges,

                        hadLaterChanges:
                          previewChanges.some(
                            (change) =>
                              change.changedAfterEvent,
                          ),
                      }),
                    ),
                },

                select: {
                  id:
                    true,
                },
              });

            return {
              serverId:
                updatedServer.id,

              revertAuditLogId:
                revertAuditLog.id,
            };
          },

          {
            isolationLevel:
              Prisma.TransactionIsolationLevel
                .Serializable,
          },
        );

      /*
       * Las relaciones se recuperan fuera de la transacción,
       * después de confirmar las dos escrituras.
       */
      const refreshedServer =
        await this.getServerForPreview(
          transactionResult.serverId,
        );

      return {
        message:
          `Cambio #${context.auditLog.id} revertido correctamente`,

        sourceAuditLogId:
          context.auditLog.id,

        revertAuditLogId:
          transactionResult.revertAuditLogId,

        server:
          refreshedServer,
      };
    } catch (error) {
      this.handleUniqueConstraintError(
        error,
      );

      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code ===
          'P2034'
      ) {
        throw new ConflictException(
          'La reversión no pudo completarse porque el servidor fue modificado simultáneamente. Actualiza el historial e inténtalo nuevamente.',
        );
      }

      throw error;
    }
  }

  private async getRevertContext(
    auditLogId: number,
    currentUser: CurrentUser,
  ) {
    const auditLog =
      await this.prisma.auditLog.findUnique({
        where: {
          id:
            auditLogId,
        },

        include: {
          user: {
            select: {
              id:
                true,

              username:
                true,

              name:
                true,
            },
          },

          company: {
            select: {
              id:
                true,

              name:
                true,

              slug:
                true,
            },
          },
        },
      });

    if (
      !auditLog
    ) {
      throw new NotFoundException(
        currentUser.role ===
          Role.ADMIN
          ? 'Evento de auditoría no encontrado'
          : 'Evento de auditoría no encontrado o no accesible',
      );
    }

    if (
      currentUser.role !==
        Role.ADMIN &&
      (
        auditLog.entityType !==
          'SERVER' ||
        auditLog.entityId ===
          null
      )
    ) {
      throw new NotFoundException(
        'Evento de auditoría no encontrado o no accesible',
      );
    }

    if (
      auditLog.action !==
        'UPDATE'
    ) {
      throw new ConflictException(
        'Solo los eventos UPDATE pueden revertirse',
      );
    }

    if (
      auditLog.entityType !==
        'SERVER'
    ) {
      throw new ConflictException(
        'Por ahora solo se admite rollback de servidores',
      );
    }

    if (
      auditLog.entityId ===
        null
    ) {
      throw new ConflictException(
        'El evento no tiene un servidor asociado',
      );
    }

    const server =
      await this.getServerForPreview(
        auditLog.entityId,
      );

    await this.assertCurrentUserCanAccessServer(
      server.companyId,
      currentUser,
    );

    const existingRevert =
      await this.findExistingRevert(
        auditLog.id,
        auditLog.entityId,
      );

    if (
      existingRevert
    ) {
      throw new ConflictException(
        `El evento #${auditLog.id} ya fue revertido por el evento #${existingRevert.id}`,
      );
    }

    const changes =
      this.readStoredChanges(
        auditLog.details,
      );

    if (
      changes.length ===
        0
    ) {
      throw new ConflictException(
        'Este evento no contiene datos reversibles',
      );
    }

    for (
      const change
      of changes
    ) {
      if (
        !REVERSIBLE_SERVER_FIELDS.has(
          change.field,
        )
      ) {
        throw new ConflictException(
          `El evento contiene el campo no reversible ${change.field}`,
        );
      }
    }

    return {
      auditLog,
      server,
      changes,
    };
  }

  private async findExistingRevert(
    sourceAuditLogId: number,
    entityId: number,
  ): Promise<{
    id: number;
  } | null> {
    const revertEvents =
      await this.prisma.auditLog.findMany({
        where: {
          action:
            'REVERT',

          entityType:
            'SERVER',

          entityId,
        },

        select: {
          id:
            true,

          details:
            true,
        },

        orderBy: {
          createdAt:
            'desc',
        },
      });

    for (
      const event
      of revertEvents
    ) {
      if (
        !event.details ||
        typeof event.details !==
          'object' ||
        Array.isArray(
          event.details,
        )
      ) {
        continue;
      }

      const details =
        event.details as
          Prisma.JsonObject;

      if (
        details[
          'sourceAuditLogId'
        ] ===
        sourceAuditLogId
      ) {
        return {
          id:
            event.id,
        };
      }
    }

    return null;
  }

  private readStoredChanges(
    details:
      Prisma.JsonValue |
      null,
  ): StoredAuditChange[] {
    if (
      !details ||
      typeof details !==
        'object' ||
      Array.isArray(
        details,
      )
    ) {
      return [];
    }

    const detailsObject =
      details as
        Prisma.JsonObject;

    const rawChanges =
      detailsObject[
        'changes'
      ];

    if (
      !Array.isArray(
        rawChanges,
      )
    ) {
      return [];
    }

    const changes:
      StoredAuditChange[] =
      [];

    for (
      const rawChange
      of rawChanges
    ) {
      if (
        !rawChange ||
        typeof rawChange !==
          'object' ||
        Array.isArray(
          rawChange,
        )
      ) {
        continue;
      }

      const value =
        rawChange as
          Prisma.JsonObject;

      if (
        typeof value[
          'field'
        ] !==
          'string' ||
        typeof value[
          'label'
        ] !==
          'string' ||
        !Object.prototype.hasOwnProperty.call(
          value,
          'beforeValue',
        ) ||
        !Object.prototype.hasOwnProperty.call(
          value,
          'afterValue',
        )
      ) {
        continue;
      }

      changes.push({
        field:
          value[
            'field'
          ] as string,

        label:
          value[
            'label'
          ] as string,

        before:
          value[
            'before'
          ],

        after:
          value[
            'after'
          ],

        beforeValue:
          value[
            'beforeValue'
          ],

        afterValue:
          value[
            'afterValue'
          ],
      });
    }

    return changes;
  }

  private async buildPreviewChanges(
    server:
      Awaited<
        ReturnType<
          AuditService[
            'getServerForPreview'
          ]
        >
      >,
    changes:
      StoredAuditChange[],
  ): Promise<
    RevertPreviewChange[]
  > {
    const result:
      RevertPreviewChange[] =
      [];

    for (
      const change
      of changes
    ) {
      const currentValue =
        this.getCurrentValue(
          server,
          change.field,
        );

      const changedAfterEvent =
        !this.valuesEqual(
          currentValue,
          change.afterValue,
          change.field,
        );

      result.push({
        field:
          change.field,

        label:
          change.label,

        currentValue,

        currentDisplay:
          this.getCurrentDisplayValue(
            server,
            change.field,
          ),

        recordedAfterValue:
          change.afterValue,

        targetValue:
          change.beforeValue,

        targetDisplay:
          change.before,

        changedAfterEvent,

        warning:
          changedAfterEvent
            ? 'Este campo fue modificado nuevamente después de este evento.'
            : null,
      });
    }

    return result;
  }

  private async getServerForPreview(
    id: number,
  ) {
    const server =
      await this.prisma.server.findUnique({
        where: {
          id,
        },

        include:
          this.getServerInclude(),
      });

    if (
      !server
    ) {
      throw new NotFoundException(
        'Servidor no encontrado',
      );
    }

    return server;
  }

  private getCurrentValue(
    server:
      Awaited<
        ReturnType<
          AuditService[
            'getServerForPreview'
          ]
        >
      >,
    field: string,
  ): unknown {
    switch (
      field
    ) {
      case 'hostname':
        return server.hostname;

      case 'ipAddress':
        return server.ipAddress;

      case 'environment':
        return server.environment;

      case 'cpuCores':
        return server.cpuCores;

      case 'ramGb':
        return server.ramGb;

      case 'diskGb':
        return server.diskGb;

      case 'notes':
        return server.notes;

      case 'active':
        return server.active;

      case 'servicesOnitec':
        return server.servicesOnitec;

      case 'companyId':
        return server.companyId;

      case 'operatingSystemId':
        return server.operatingSystemId;

      case 'software':
        return server.software
          .map(
            (item) => ({
              softwareId:
                item.softwareId,

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

      default:
        return null;
    }
  }

  private getCurrentDisplayValue(
    server:
      Awaited<
        ReturnType<
          AuditService[
            'getServerForPreview'
          ]
        >
      >,
    field: string,
  ): unknown {
    switch (
      field
    ) {
      case 'companyId':
        return server.company
          ?.name ??
          null;

      case 'operatingSystemId':
        return server.operatingSystem
          ? `${server.operatingSystem.name} ${server.operatingSystem.version}`
          : null;

      case 'software':
        return server.software
          .map(
            (item) =>
              `${item.software.name} ${item.version}`,
          );

      case 'active':
        return server.active
          ? 'Activo'
          : 'Inactivo';

      case 'servicesOnitec':
        return server.servicesOnitec
          ? 'Incluido'
          : 'No incluido';

      default:
        return this.getCurrentValue(
          server,
          field,
        );
    }
  }

  private valuesEqual(
    left: unknown,
    right: unknown,
    field: string,
  ): boolean {
    if (
      field ===
      'software'
    ) {
      try {
        const leftSoftware =
          this.readSoftwareValue(
            left,
          );

        const rightSoftware =
          this.readSoftwareValue(
            right,
          );

        return (
          JSON.stringify(
            leftSoftware,
          ) ===
          JSON.stringify(
            rightSoftware,
          )
        );
      } catch {
        return false;
      }
    }

    return (
      JSON.stringify(
        left,
      ) ===
      JSON.stringify(
        right,
      )
    );
  }

  private async validateRevertTargets(
    serverId: number,
    changes:
      StoredAuditChange[],
    currentUser: CurrentUser,
  ) {
    for (
      const change
      of changes
    ) {
      switch (
        change.field
      ) {
        case 'hostname': {
          const hostname =
            this.readNullableStringAsRequired(
              change.beforeValue,
              'Hostname anterior inválido',
            );

          const duplicate =
            await this.prisma.server.findFirst({
              where: {
                hostname,

                NOT: {
                  id:
                    serverId,
                },
              },

              select: {
                id:
                  true,

                hostname:
                  true,
              },
            });

          if (
            duplicate
          ) {
            throw new ConflictException(
              `No es posible revertir: el hostname ${hostname} se encuentra en uso`,
            );
          }

          break;
        }

        case 'ipAddress': {
          const ipAddress =
            this.readNullableString(
              change.beforeValue,
              'IP anterior inválida',
            );

          if (
            ipAddress
          ) {
            const duplicate =
              await this.prisma.server.findFirst({
                where: {
                  ipAddress,

                  NOT: {
                    id:
                      serverId,
                  },
                },

                select: {
                  id:
                    true,

                  hostname:
                    true,

                  companyId:
                    true,
                },
              });

            if (
              duplicate
            ) {
              const canSeeIpOwner =
                await this.canAccessCompany(
                  duplicate.companyId,
                  currentUser,
                );

              throw new ConflictException(
                canSeeIpOwner
                  ? `No es posible revertir: la IP ${ipAddress} se encuentra en uso por el servidor ${duplicate.hostname}`
                  : `No es posible revertir: la IP ${ipAddress} se encuentra en uso por otro servidor`,
              );
            }
          }

          break;
        }

        case 'companyId': {
          const companyId =
            this.readNullableInteger(
              change.beforeValue,
              'Empresa anterior inválida',
            );

          if (
            companyId !==
            null
          ) {
            await assertCompanyAccessible(
              this.prisma,
              currentUser,
              companyId,
            );
            const company =
              await this.prisma.company.findUnique({
                where: {
                  id:
                    companyId,
                },

                select: {
                  id:
                    true,
                },
              });

            if (
              !company
            ) {
              throw new ConflictException(
                'No es posible revertir: la empresa anterior ya no existe',
              );
            }
          }

          break;
        }

        case 'operatingSystemId': {
          const operatingSystemId =
            this.readNullableInteger(
              change.beforeValue,
              'Sistema operativo anterior inválido',
            );

          if (
            operatingSystemId !==
            null
          ) {
            const operatingSystem =
              await this.prisma.operatingSystem.findUnique({
                where: {
                  id:
                    operatingSystemId,
                },

                select: {
                  id:
                    true,
                },
              });

            if (
              !operatingSystem
            ) {
              throw new ConflictException(
                'No es posible revertir: el sistema operativo anterior ya no existe',
              );
            }
          }

          break;
        }

        case 'software': {
          const software =
            this.readSoftwareValue(
              change.beforeValue,
            );

          const ids =
            software.map(
              (item) =>
                item.softwareId,
            );

          if (
            new Set(
              ids,
            ).size !==
            ids.length
          ) {
            throw new ConflictException(
              'No es posible revertir: el estado anterior contiene software duplicado',
            );
          }

          if (
            ids.length >
            0
          ) {
            const existing =
              await this.prisma.software.count({
                where: {
                  id: {
                    in:
                      ids,
                  },
                },
              });

            if (
              existing !==
              ids.length
            ) {
              throw new ConflictException(
                'No es posible revertir: uno o más software del estado anterior ya no existen',
              );
            }
          }

          break;
        }

        case 'environment':
        case 'notes':
          this.readNullableString(
            change.beforeValue,
            `Valor anterior inválido para ${change.label}`,
          );
          break;

        case 'cpuCores':
        case 'ramGb':
        case 'diskGb':
          this.readNullableInteger(
            change.beforeValue,
            `Valor anterior inválido para ${change.label}`,
          );
          break;

        case 'active':
          this.readBoolean(
            change.beforeValue,
            'Estado anterior inválido',
          );
          break;

        case 'servicesOnitec':
          this.readBoolean(
            change.beforeValue,
            'Configuración anterior de Servicios Onitec inválida',
          );
          break;

        default:
          throw new ConflictException(
            `El campo ${change.field} no admite reversión`,
          );
      }
    }
  }

  private readNullableString(
    value: unknown,
    message: string,
  ): string | null {
    if (
      value ===
        null
    ) {
      return null;
    }

    if (
      typeof value !==
        'string'
    ) {
      throw new ConflictException(
        message,
      );
    }

    return value;
  }

  private readNullableStringAsRequired(
    value: unknown,
    message: string,
  ): string {
    if (
      typeof value !==
        'string' ||
      !value.trim()
    ) {
      throw new ConflictException(
        message,
      );
    }

    return value.trim();
  }

  private readNullableInteger(
    value: unknown,
    message: string,
  ): number | null {
    if (
      value ===
        null
    ) {
      return null;
    }

    if (
      typeof value !==
        'number' ||
      !Number.isInteger(
        value,
      )
    ) {
      throw new ConflictException(
        message,
      );
    }

    return value;
  }

  private readBoolean(
    value: unknown,
    message: string,
  ): boolean {
    if (
      typeof value !==
        'boolean'
    ) {
      throw new ConflictException(
        message,
      );
    }

    return value;
  }

  private readSoftwareValue(
    value: unknown,
  ): ServerSoftwareValue[] {
    if (
      !Array.isArray(
        value,
      )
    ) {
      throw new ConflictException(
        'Estado anterior de software inválido',
      );
    }

    const result:
      ServerSoftwareValue[] =
      [];

    for (
      const item
      of value
    ) {
      if (
        !item ||
        typeof item !==
          'object' ||
        Array.isArray(
          item,
        )
      ) {
        throw new ConflictException(
          'Estado anterior de software inválido',
        );
      }

      const software =
        item as
          Record<
            string,
            unknown
          >;

      const softwareId =
        software[
          'softwareId'
        ];

      const version =
        software[
          'version'
        ];

      const notes =
        software[
          'notes'
        ];

      if (
        typeof softwareId !==
          'number' ||
        !Number.isInteger(
          softwareId,
        ) ||
        softwareId <=
          0 ||
        typeof version !==
          'string' ||
        (
          notes !==
            null &&
          notes !==
            undefined &&
          typeof notes !==
            'string'
        )
      ) {
        throw new ConflictException(
          'Estado anterior de software inválido',
        );
      }

      result.push({
        softwareId,

        version,

        notes:
          typeof notes ===
            'string'
            ? notes
            : null,
      });
    }

    return result.sort(
      (
        a,
        b,
      ) =>
        a.softwareId -
        b.softwareId,
    );
  }

  private async assertHistoryEntityAccess(
    entityType: string,
    entityId: number,
    currentUser: CurrentUser,
  ) {
    if (entityType === 'SERVER') {
      await this.assertServerAccess(
        entityId,
        currentUser,
      );
      return;
    }

    if (
      entityType ===
        'SERVER_IMPORT_BATCH' &&
      currentUser.role !==
        Role.ADMIN
    ) {
      const batch =
        await this.prisma.serverImportBatch.findFirst({
          where: {
            id: entityId,
            userId: currentUser.sub,
          },
          select: {
            id: true,
          },
        });

      if (!batch) {
        throw new NotFoundException(
          'Carga masiva no encontrada o no accesible',
        );
      }
    }
  }

  private async assertServerAccess(
    serverId: number,
    currentUser: CurrentUser,
  ) {
    const server =
      await this.prisma.server.findUnique({
        where: {
          id:
            serverId,
        },

        select: {
          companyId:
            true,
        },
      });

    if (
      !server
    ) {
      throw new NotFoundException(
        'Servidor no encontrado',
      );
    }

    await this.assertCurrentUserCanAccessServer(
      server.companyId,
      currentUser,
    );
  }

  private async assertCurrentUserCanAccessServer(
    serverCompanyId:
      number |
      null,
    currentUser:
      CurrentUser,
  ) {
    if (
      serverCompanyId ===
      null
    ) {
      if (
        currentUser.role !==
        Role.ADMIN
      ) {
        throw new ForbiddenException(
          'No tienes acceso a este servidor',
        );
      }

      return;
    }

    await assertCompanyAccessible(
      this.prisma,
      currentUser,
      serverCompanyId,
    );
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

  private async canAccessCompany(
    companyId: number | null,
    currentUser: CurrentUser,
  ): Promise<boolean> {
    if (
      currentUser.role ===
        Role.ADMIN
    ) {
      return true;
    }

    if (
      companyId ===
        null
    ) {
      return false;
    }

    try {
      await assertCompanyAccessible(
        this.prisma,
        currentUser,
        companyId,
      );
      return true;
    } catch {
      return false;
    }
  }

  private sanitizeAuditValue(
    value: unknown,
    parentKey?: string,
  ): unknown {
    if (
      parentKey &&
      SENSITIVE_AUDIT_KEY_PATTERN.test(
        parentKey,
      )
    ) {
      return REDACTED_AUDIT_VALUE;
    }

    if (Array.isArray(value)) {
      return value.map(
        (item) =>
          this.sanitizeAuditValue(
            item,
          ),
      );
    }

    if (
      value ===
        null ||
      typeof value !==
        'object'
    ) {
      return value;
    }

    const source =
      value as
        Record<
          string,
          unknown
        >;

    const result:
      Record<
        string,
        unknown
      > = {};

    const auditField =
      typeof source['field'] ===
        'string'
        ? source['field']
        : null;

    const sensitiveChange =
      auditField !==
        null &&
      SENSITIVE_AUDIT_FIELD_PATTERN.test(
        auditField,
      );

    for (
      const [key, child]
      of Object.entries(source)
    ) {
      if (
        SENSITIVE_AUDIT_KEY_PATTERN.test(
          key,
        )
      ) {
        result[key] =
          REDACTED_AUDIT_VALUE;
        continue;
      }

      if (
        sensitiveChange &&
        (
          key === 'before' ||
          key === 'after' ||
          key === 'beforeValue' ||
          key === 'afterValue'
        )
      ) {
        result[key] =
          REDACTED_AUDIT_VALUE;
        continue;
      }

      result[key] =
        this.sanitizeAuditValue(
          child,
          key,
        );
    }

    return result;
  }

  private toInputJsonValue(
    value: unknown,
  ): Prisma.InputJsonValue {
    const serialized =
      JSON.stringify(
        value,
      );

    if (
      serialized ===
      undefined
    ) {
      throw new BadRequestException(
        'Los detalles de auditoría no son serializables',
      );
    }

    return JSON.parse(
      serialized,
    ) as Prisma.InputJsonValue;
  }

  private handleUniqueConstraintError(
    error: unknown,
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
          'No es posible revertir: la IP anterior se encuentra en uso por otro servidor',
        );
      }

      if (
        targetText.includes(
          'hostname',
        )
      ) {
        throw new ConflictException(
          'No es posible revertir: el hostname anterior se encuentra en uso por otro servidor',
        );
      }
    }
  }
}
