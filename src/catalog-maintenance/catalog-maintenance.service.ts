import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

interface CurrentUser {
  sub: number;
  username: string;
  companyId?: number | null;
}

@Injectable()
export class CatalogMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async deleteSoftware(
    id: number,
    currentUser: CurrentUser,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const software =
            await tx.software.findUnique({
              where: {
                id,
              },
              select: {
                id: true,
                name: true,
                category: true,
                active: true,
                eolProductKey: true,
              },
            });

          if (!software) {
            throw new NotFoundException(
              'Sistema no encontrado',
            );
          }

          const [
            installationCount,
            tariffCount,
          ] = await Promise.all([
            tx.serverSoftware.count({
              where: {
                softwareId: id,
              },
            }),
            tx.pricingTariff.count({
              where: {
                softwareId: id,
              },
            }),
          ]);

          if (installationCount > 0) {
            throw new ConflictException(
              `No se puede eliminar ${software.name}: está instalado en ${installationCount} servidor${installationCount === 1 ? '' : 'es'}. Retira primero sus asociaciones del inventario o desactívalo.`,
            );
          }

          if (tariffCount > 0) {
            throw new ConflictException(
              `No se puede eliminar ${software.name}: tiene ${tariffCount} tarifa${tariffCount === 1 ? '' : 's'} asociada${tariffCount === 1 ? '' : 's'}. Elimina o reasigna primero esas tarifas.`,
            );
          }

          await tx.software.delete({
            where: {
              id,
            },
          });

          await tx.auditLog.create({
            data: {
              action: 'DELETE',
              entityType: 'SOFTWARE',
              entityId:
                software.id,
              entityName:
                software.name,
              userId:
                currentUser.sub,
              companyId: null,
              details:
                this.toInputJsonValue({
                  message:
                    'Sistema eliminado del catálogo',
                  deleted: {
                    id:
                      software.id,
                    name:
                      software.name,
                    category:
                      software.category,
                    active:
                      software.active,
                    eolProductKey:
                      software.eolProductKey,
                  },
                }),
            },
          });

          return {
            deleted: true,
            id:
              software.id,
            name:
              software.name,
          };
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel
              .Serializable,
        },
      );
    } catch (error) {
      this.handleDeleteError(error);
      throw error;
    }
  }

  async deleteOperatingSystem(
    id: number,
    currentUser: CurrentUser,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const operatingSystem =
            await tx.operatingSystem.findUnique({
              where: {
                id,
              },
              select: {
                id: true,
                name: true,
                version: true,
                active: true,
                eolProductKey: true,
              },
            });

          if (!operatingSystem) {
            throw new NotFoundException(
              'Sistema operativo no encontrado',
            );
          }

          const serverCount =
            await tx.server.count({
              where: {
                operatingSystemId: id,
              },
            });

          if (serverCount > 0) {
            throw new ConflictException(
              `No se puede eliminar ${operatingSystem.name} ${operatingSystem.version}: está asignado a ${serverCount} servidor${serverCount === 1 ? '' : 'es'}. Reasigna primero esos servidores o desactiva el registro.`,
            );
          }

          const otherSameNameCount =
            await tx.operatingSystem.count({
              where: {
                id: {
                  not: id,
                },
                name: {
                  equals:
                    operatingSystem.name,
                  mode: 'insensitive',
                },
              },
            });

          if (otherSameNameCount === 0) {
            const tariffCount =
              await tx.pricingTariff.count({
                where: {
                  operatingSystemName: {
                    equals:
                      operatingSystem.name,
                    mode: 'insensitive',
                  },
                },
              });

            if (tariffCount > 0) {
              throw new ConflictException(
                `No se puede eliminar ${operatingSystem.name} ${operatingSystem.version}: es el último registro de esa familia y existen ${tariffCount} tarifa${tariffCount === 1 ? '' : 's'} asociada${tariffCount === 1 ? '' : 's'} a ${operatingSystem.name}.`,
              );
            }
          }

          await tx.operatingSystem.delete({
            where: {
              id,
            },
          });

          await tx.auditLog.create({
            data: {
              action: 'DELETE',
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
                    'Sistema operativo eliminado del catálogo',
                  deleted: {
                    id:
                      operatingSystem.id,
                    name:
                      operatingSystem.name,
                    version:
                      operatingSystem.version,
                    active:
                      operatingSystem.active,
                    eolProductKey:
                      operatingSystem.eolProductKey,
                  },
                }),
            },
          });

          return {
            deleted: true,
            id:
              operatingSystem.id,
            name:
              operatingSystem.name,
            version:
              operatingSystem.version,
          };
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel
              .Serializable,
        },
      );
    } catch (error) {
      this.handleDeleteError(error);
      throw error;
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

  private handleDeleteError(
    error: unknown,
  ): void {
    if (
      error instanceof
        Prisma.PrismaClientKnownRequestError
    ) {
      if (error.code === 'P2003') {
        throw new ConflictException(
          'No se puede eliminar el registro porque todavía tiene relaciones activas en el inventario.',
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
