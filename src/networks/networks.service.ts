import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

import { CreateIpReservationDto } from './dto/create-ip-reservation.dto.js';
import { CreateNetworkDto } from './dto/create-network.dto.js';
import { UpdateNetworkDto } from './dto/update-network.dto.js';
import {
  cidrsOverlap,
  isUsableIpv4InCidr,
  numberToIpv4,
  parseIpv4Cidr,
} from './ipv4-cidr.js';

interface CurrentUser {
  sub: number;
}

export type IpInventoryStatus =
  | 'FREE'
  | 'USED'
  | 'RESERVED';

export interface IpInventoryFilters {
  search?: string;
  status?: IpInventoryStatus;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class NetworksService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async findAll() {
    const [
      networks,
      servers,
      reservations,
    ] = await Promise.all([
      this.prisma.network.findMany({
        orderBy: [
          { active: 'desc' },
          { name: 'asc' },
        ],
      }),
      this.prisma.server.findMany({
        where: {
          active: true,
          ipAddress: {
            not: null,
          },
        },
        select: {
          id: true,
          hostname: true,
          ipAddress: true,
        },
      }),
      this.prisma.ipReservation.findMany({
        where: {
          active: true,
        },
        select: {
          id: true,
          networkId: true,
          ipAddress: true,
          description: true,
        },
      }),
    ]);

    return networks.map((network) => {
      const parsed = this.parseNetworkCidr(network.cidr);

      const usedIps = new Set(
        servers
          .filter(
            (server) =>
              server.ipAddress &&
              isUsableIpv4InCidr(
                server.ipAddress,
                network.cidr,
              ),
          )
          .map(
            (server) =>
              server.ipAddress as string,
          ),
      );

      const reservedIps = new Set(
        reservations
          .filter(
            (reservation) =>
              reservation.networkId === network.id &&
              !usedIps.has(reservation.ipAddress),
          )
          .map(
            (reservation) =>
              reservation.ipAddress,
          ),
      );

      const used = usedIps.size;
      const reserved = reservedIps.size;
      const free = Math.max(
        0,
        parsed.totalUsable - used - reserved,
      );

      return {
        ...network,
        range: {
          firstUsable:
            numberToIpv4(parsed.firstUsable),
          lastUsable:
            numberToIpv4(parsed.lastUsable),
          totalUsable:
            parsed.totalUsable,
        },
        totals: {
          used,
          reserved,
          free,
        },
      };
    });
  }

  async findIpInventory(
    networkId: number,
    filters: IpInventoryFilters = {},
  ) {
    const network = await this.getNetwork(networkId);
    const parsed = this.parseNetworkCidr(network.cidr);
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(
      250,
      Math.max(10, filters.pageSize ?? 100),
    );
    const normalizedSearch =
      filters.search?.trim().toLowerCase() ?? '';

    const [servers, reservations] =
      await Promise.all([
        this.prisma.server.findMany({
          where: {
            ipAddress: {
              not: null,
            },
          },
          select: {
            id: true,
            hostname: true,
            ipAddress: true,
            active: true,
            company: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        }),
        this.prisma.ipReservation.findMany({
          where: {
            networkId,
            active: true,
          },
          select: {
            id: true,
            ipAddress: true,
            description: true,
          },
        }),
      ]);

    const activeByIp = new Map<
      string,
      (typeof servers)[number]
    >();
    const inactiveByIp = new Map<
      string,
      (typeof servers)[number]
    >();

    for (const server of servers) {
      if (
        !server.ipAddress ||
        !isUsableIpv4InCidr(
          server.ipAddress,
          network.cidr,
        )
      ) {
        continue;
      }

      if (server.active) {
        activeByIp.set(
          server.ipAddress,
          server,
        );
      } else if (
        !inactiveByIp.has(server.ipAddress)
      ) {
        inactiveByIp.set(
          server.ipAddress,
          server,
        );
      }
    }

    const reservationByIp = new Map(
      reservations.map((reservation) => [
        reservation.ipAddress,
        reservation,
      ]),
    );

    const items = [] as Array<{
      ipAddress: string;
      status: IpInventoryStatus;
      server: null | {
        id: number;
        hostname: string;
        company: null | {
          id: number;
          name: string;
        };
      };
      previousServer: null | {
        id: number;
        hostname: string;
        company: null | {
          id: number;
          name: string;
        };
      };
      reservation: null | {
        id: number;
        description: string | null;
      };
      requiresRelease: boolean;
    }>;

    let used = 0;
    let reserved = 0;
    let free = 0;

    for (
      let value = parsed.firstUsable;
      value <= parsed.lastUsable;
      value += 1
    ) {
      const ipAddress = numberToIpv4(value);
      const activeServer = activeByIp.get(ipAddress);
      const reservation = reservationByIp.get(ipAddress);
      const previousServer = inactiveByIp.get(ipAddress);

      let status: IpInventoryStatus;

      if (activeServer) {
        status = 'USED';
        used += 1;
      } else if (reservation) {
        status = 'RESERVED';
        reserved += 1;
      } else {
        status = 'FREE';
        free += 1;
      }

      if (
        filters.status &&
        status !== filters.status
      ) {
        continue;
      }

      const searchText = [
        ipAddress,
        activeServer?.hostname,
        activeServer?.company?.name,
        previousServer?.hostname,
        previousServer?.company?.name,
        reservation?.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (
        normalizedSearch &&
        !searchText.includes(normalizedSearch)
      ) {
        continue;
      }

      items.push({
        ipAddress,
        status,
        server: activeServer
          ? {
              id: activeServer.id,
              hostname: activeServer.hostname,
              company: activeServer.company,
            }
          : null,
        previousServer: previousServer
          ? {
              id: previousServer.id,
              hostname: previousServer.hostname,
              company: previousServer.company,
            }
          : null,
        reservation: reservation
          ? {
              id: reservation.id,
              description: reservation.description,
            }
          : null,
        requiresRelease:
          status === 'FREE' &&
          Boolean(previousServer),
      });
    }

    const filtered = items.length;
    const totalPages = Math.max(
      1,
      Math.ceil(filtered / pageSize),
    );
    const effectivePage = Math.min(
      page,
      totalPages,
    );
    const start =
      (effectivePage - 1) * pageSize;

    return {
      network: {
        ...network,
        range: {
          firstUsable:
            numberToIpv4(parsed.firstUsable),
          lastUsable:
            numberToIpv4(parsed.lastUsable),
          totalUsable:
            parsed.totalUsable,
        },
      },
      totals: {
        used,
        reserved,
        free,
      },
      filters: {
        search: filters.search ?? '',
        status: filters.status ?? null,
      },
      page: effectivePage,
      pageSize,
      totalPages,
      filtered,
      items: items.slice(
        start,
        start + pageSize,
      ),
    };
  }

  async create(
    dto: CreateNetworkDto,
    currentUser: CurrentUser,
  ) {
    const name = dto.name.trim();
    const parsed = this.parseNetworkCidr(dto.cidr);

    if (!name) {
      throw new BadRequestException(
        'El nombre de la red/VLAN es obligatorio',
      );
    }

    try {
      const created =
        await this.prisma.$transaction(
          async (tx) => {
            await this.assertNetworkUniqueAndNonOverlapping(
              name,
              parsed.cidr,
              undefined,
              tx,
            );

            const network =
              await tx.network.create({
                data: {
                  name,
                  cidr: parsed.cidr,
                  description:
                    dto.description?.trim() || null,
                  active: dto.active ?? true,
                },
              });

            await tx.auditLog.create({
              data: {
                action: 'CREATE',
                entityType: 'NETWORK',
                entityId: network.id,
                entityName: network.name,
                userId: currentUser.sub,
                details: this.toInputJsonValue({
                  message: 'Red/VLAN creada',
                  cidr: network.cidr,
                }),
              },
            });

            return network;
          },
          {
            isolationLevel:
              Prisma.TransactionIsolationLevel
                .Serializable,
          },
        );

      return created;
    } catch (error) {
      this.handleNetworkWriteError(error);
      throw error;
    }
  }

  async update(
    id: number,
    dto: UpdateNetworkDto,
    currentUser: CurrentUser,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const existing =
            await this.getNetwork(id, tx);

          const name =
            dto.name?.trim() ?? existing.name;

          if (!name) {
            throw new BadRequestException(
              'El nombre de la red/VLAN es obligatorio',
            );
          }

          const parsed =
            this.parseNetworkCidr(
              dto.cidr ?? existing.cidr,
            );

          await this.assertNetworkUniqueAndNonOverlapping(
            name,
            parsed.cidr,
            id,
            tx,
          );

          if (
            parsed.cidr !== existing.cidr
          ) {
            const activeServers =
              await tx.server.findMany({
                where: {
                  active: true,
                  ipAddress: {
                    not: null,
                  },
                },
                select: {
                  id: true,
                  hostname: true,
                  ipAddress: true,
                },
              });

            const activeReservations =
              await tx.ipReservation.findMany({
                where: {
                  networkId: id,
                  active: true,
                },
                select: {
                  id: true,
                  ipAddress: true,
                },
              });

            const serverOutside =
              activeServers.find(
                (server) =>
                  server.ipAddress &&
                  isUsableIpv4InCidr(
                    server.ipAddress,
                    existing.cidr,
                  ) &&
                  !isUsableIpv4InCidr(
                    server.ipAddress,
                    parsed.cidr,
                  ),
              );

            if (serverOutside?.ipAddress) {
              throw new ConflictException(
                `No se puede cambiar el CIDR: el servidor ${serverOutside.hostname} usa una IP de la red actual que quedaría fuera del nuevo rango`,
              );
            }

            const reservationOutside =
              activeReservations.find(
                (reservation) =>
                  !isUsableIpv4InCidr(
                    reservation.ipAddress,
                    parsed.cidr,
                  ),
              );

            if (reservationOutside) {
              throw new ConflictException(
                `No se puede cambiar el CIDR: la reserva ${reservationOutside.ipAddress} quedaría fuera del nuevo rango`,
              );
            }
          }

          const updated =
            await tx.network.update({
              where: { id },
              data: {
                name,
                cidr: parsed.cidr,
                description:
                  dto.description !== undefined
                    ? dto.description.trim() || null
                    : existing.description,
                active:
                  dto.active ?? existing.active,
              },
            });

          await tx.auditLog.create({
            data: {
              action: 'UPDATE',
              entityType: 'NETWORK',
              entityId: updated.id,
              entityName: updated.name,
              userId: currentUser.sub,
              details: this.toInputJsonValue({
                message: 'Red/VLAN modificada',
                before: {
                  name: existing.name,
                  cidr: existing.cidr,
                  description: existing.description,
                  active: existing.active,
                },
                after: {
                  name: updated.name,
                  cidr: updated.cidr,
                  description: updated.description,
                  active: updated.active,
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
      this.handleNetworkWriteError(error);
      throw error;
    }
  }

  async remove(
    id: number,
    currentUser: CurrentUser,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const existing =
            await this.getNetwork(id, tx);

          const servers =
            await tx.server.findMany({
              where: {
                ipAddress: {
                  not: null,
                },
              },
              select: {
                id: true,
                hostname: true,
                ipAddress: true,
                active: true,
              },
            });

          const activeReservations =
            await tx.ipReservation.findMany({
              where: {
                networkId: id,
                active: true,
              },
              select: {
                id: true,
                ipAddress: true,
              },
            });

          const reservationCount =
            await tx.ipReservation.count({
              where: {
                networkId: id,
              },
            });

          const linkedServer =
            servers.find(
              (server) =>
                server.ipAddress &&
                isUsableIpv4InCidr(
                  server.ipAddress,
                  existing.cidr,
                ),
            );

          if (linkedServer?.ipAddress) {
            throw new ConflictException(
              `No se puede eliminar la red/VLAN: la IP ${linkedServer.ipAddress} sigue vinculada al servidor ${linkedServer.hostname}${linkedServer.active ? ' activo' : ' inactivo'}`,
            );
          }

          if (activeReservations.length > 0) {
            const firstReservation =
              activeReservations[0];

            throw new ConflictException(
              `No se puede eliminar la red/VLAN: existen ${activeReservations.length} reserva(s) IP activa(s). Libera primero la reserva ${firstReservation.ipAddress}`,
            );
          }

          await tx.network.delete({
            where: {
              id,
            },
          });

          await tx.auditLog.create({
            data: {
              action: 'DELETE',
              entityType: 'NETWORK',
              entityId: existing.id,
              entityName: existing.name,
              userId: currentUser.sub,
              details: this.toInputJsonValue({
                message: 'Red/VLAN eliminada',
                cidr: existing.cidr,
                description: existing.description,
                active: existing.active,
                removedInactiveReservations:
                  reservationCount,
              }),
            },
          });

          return {
            deleted: true,
            id: existing.id,
            name: existing.name,
            cidr: existing.cidr,
          };
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel
              .Serializable,
        },
      );
    } catch (error) {
      this.handleNetworkWriteError(error);
      throw error;
    }
  }

  async createReservation(
    networkId: number,
    dto: CreateIpReservationDto,
    currentUser: CurrentUser,
  ) {
    const ipAddress = dto.ipAddress.trim();

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const network =
            await this.getNetwork(
              networkId,
              tx,
            );

          if (!network.active) {
            throw new ConflictException(
              'No se pueden reservar IPs en una red inactiva',
            );
          }

          if (
            !isUsableIpv4InCidr(
              ipAddress,
              network.cidr,
            )
          ) {
            throw new BadRequestException(
              `La IP ${ipAddress} no es un host utilizable de ${network.cidr}`,
            );
          }

          const activeServer =
            await tx.server.findFirst({
              where: {
                active: true,
                ipAddress,
              },
              select: {
                hostname: true,
              },
            });

          if (activeServer) {
            throw new ConflictException(
              `La IP ${ipAddress} está usada por el servidor ${activeServer.hostname}`,
            );
          }

          const existing =
            await tx.ipReservation.findUnique({
              where: {
                ipAddress,
              },
            });

          const reservation =
            existing
              ? await tx.ipReservation.update({
                  where: {
                    id: existing.id,
                  },
                  data: {
                    networkId,
                    description:
                      dto.description?.trim() || null,
                    active: true,
                  },
                })
              : await tx.ipReservation.create({
                  data: {
                    networkId,
                    ipAddress,
                    description:
                      dto.description?.trim() || null,
                  },
                });

          const action =
            existing
              ? existing.active
                ? 'UPDATE'
                : 'ACTIVATE'
              : 'CREATE';

          const message =
            existing
              ? existing.active
                ? 'Reserva IP actualizada'
                : 'Reserva IP reactivada'
              : 'IP reservada';

          await tx.auditLog.create({
            data: {
              action,
              entityType: 'IP_RESERVATION',
              entityId: reservation.id,
              entityName: reservation.ipAddress,
              userId: currentUser.sub,
              details: this.toInputJsonValue({
                message,
                networkId,
                description:
                  reservation.description,
              }),
            },
          });

          return reservation;
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel
              .Serializable,
        },
      );
    } catch (error) {
      this.handleNetworkWriteError(error);
      throw error;
    }
  }

  async releaseReservation(
    reservationId: number,
    currentUser: CurrentUser,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const reservation =
            await tx.ipReservation.findUnique({
              where: {
                id: reservationId,
              },
              include: {
                network: true,
              },
            });

          if (!reservation) {
            throw new NotFoundException(
              'Reserva IP no encontrada',
            );
          }

          if (!reservation.active) {
            return reservation;
          }

          const updated =
            await tx.ipReservation.update({
              where: {
                id: reservation.id,
              },
              data: {
                active: false,
              },
            });

          await tx.auditLog.create({
            data: {
              action: 'DEACTIVATE',
              entityType: 'IP_RESERVATION',
              entityId: updated.id,
              entityName: updated.ipAddress,
              userId: currentUser.sub,
              details: this.toInputJsonValue({
                message: 'Reserva IP liberada',
                networkId:
                  reservation.networkId,
                network:
                  reservation.network.name,
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
      this.handleNetworkWriteError(error);
      throw error;
    }
  }

  async releaseInactiveServerIp(
    networkId: number,
    ipAddress: string,
    currentUser: CurrentUser,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const network =
            await this.getNetwork(
              networkId,
              tx,
            );

          if (
            !isUsableIpv4InCidr(
              ipAddress,
              network.cidr,
            )
          ) {
            throw new BadRequestException(
              'La IP no pertenece al rango utilizable de la red',
            );
          }

          const activeServer =
            await tx.server.findFirst({
              where: {
                active: true,
                ipAddress,
              },
              select: {
                hostname: true,
              },
            });

          if (activeServer) {
            throw new ConflictException(
              `La IP está usada por el servidor activo ${activeServer.hostname}`,
            );
          }

          const inactiveServer =
            await tx.server.findFirst({
              where: {
                active: false,
                ipAddress,
              },
              select: {
                id: true,
                hostname: true,
                companyId: true,
              },
            });

          if (!inactiveServer) {
            return {
              released: false,
              message:
                'La IP ya no tiene vínculo con un servidor inactivo',
            };
          }

          await tx.server.update({
            where: {
              id: inactiveServer.id,
            },
            data: {
              ipAddress: null,
              updatedById: currentUser.sub,
            },
          });

          await tx.auditLog.create({
            data: {
              action: 'UPDATE',
              entityType: 'SERVER',
              entityId: inactiveServer.id,
              entityName:
                inactiveServer.hostname,
              userId: currentUser.sub,
              companyId:
                inactiveServer.companyId,
              details: this.toInputJsonValue({
                message:
                  'IP histórica liberada desde administración de IPs',
                fields: ['ipAddress'],
                changes: [
                  {
                    field: 'ipAddress',
                    label: 'IP',
                    before: ipAddress,
                    after: null,
                    beforeValue: ipAddress,
                    afterValue: null,
                  },
                ],
              }),
            },
          });

          return {
            released: true,
            serverId:
              inactiveServer.id,
            hostname:
              inactiveServer.hostname,
            ipAddress,
          };
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel
              .Serializable,
        },
      );
    } catch (error) {
      this.handleNetworkWriteError(error);
      throw error;
    }
  }

  private async getNetwork(
    id: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client =
      tx ?? this.prisma;

    const network =
      await client.network.findUnique({
        where: {
          id,
        },
      });

    if (!network) {
      throw new NotFoundException(
        'Red/VLAN no encontrada',
      );
    }

    return network;
  }

  private parseNetworkCidr(cidr: string) {
    try {
      return parseIpv4Cidr(cidr);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'CIDR IPv4 inválido',
      );
    }
  }

  private async assertNetworkUniqueAndNonOverlapping(
    name: string,
    cidr: string,
    excludeId?: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client =
      tx ?? this.prisma;

    const networks =
      await client.network.findMany({
        where: excludeId
          ? {
              NOT: {
                id: excludeId,
              },
            }
          : undefined,
        select: {
          id: true,
          name: true,
          cidr: true,
        },
      });

    const duplicateName =
      networks.find(
        (network) =>
          network.name.toLowerCase() ===
          name.toLowerCase(),
      );

    if (duplicateName) {
      throw new ConflictException(
        'Ya existe una red/VLAN con ese nombre',
      );
    }

    const overlap =
      networks.find(
        (network) =>
          cidrsOverlap(
            network.cidr,
            cidr,
          ),
      );

    if (overlap) {
      throw new ConflictException(
        `El rango ${cidr} se superpone con ${overlap.name} (${overlap.cidr})`,
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

  private handleNetworkWriteError(
    error: unknown,
  ): void {
    if (
      error instanceof
        Prisma.PrismaClientKnownRequestError
    ) {
      if (error.code === 'P2002') {
        throw new ConflictException(
          'Ya existe una red/VLAN o reserva con un valor único en uso',
        );
      }

      if (error.code === 'P2034') {
        throw new ConflictException(
          'La operación no pudo completarse porque los datos de red fueron modificados simultáneamente. Actualiza e inténtalo nuevamente.',
        );
      }
    }
  }
}
