import {
  Injectable,
} from '@nestjs/common';

import {
  Prisma,
  Role,
} from '@prisma/client';

import { buildScopedServerCompanyWhere } from '../company-scope/company-scope.js';

import { PrismaService } from '../prisma/prisma.service.js';

interface CurrentUser {
  sub: number;
  username: string;
  role: Role;
  companyId: number | null;
}

type EnvironmentFilter =
  | 'PRD'
  | 'QAS'
  | 'DEV'
  | undefined;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async getSummary(
    currentUser: CurrentUser,
    environment?: EnvironmentFilter,
    requestedCompanyId?: number,
  ) {
    const companyWhere =
      await buildScopedServerCompanyWhere(
        this.prisma,
        currentUser,
        requestedCompanyId,
      );

    const filteredWhere:
      Prisma.ServerWhereInput = {
      ...companyWhere,

      ...(environment
        ? {
            environment,
          }
        : {}),
    };

    const totalServers =
      await this.prisma.server.count({
        where:
          companyWhere,
      });

    const activeServers =
      await this.prisma.server.count({
        where: {
          ...companyWhere,
          active:
            true,
        },
      });

    const prdServers =
      await this.prisma.server.count({
        where: {
          ...companyWhere,
          environment:
            'PRD',
        },
      });

    const qasServers =
      await this.prisma.server.count({
        where: {
          ...companyWhere,
          environment:
            'QAS',
        },
      });

    const devServers =
      await this.prisma.server.count({
        where: {
          ...companyWhere,
          environment:
            'DEV',
        },
      });

    const servers =
      await this.prisma.server.findMany({
        where:
          filteredWhere,

        select: {
          id:
            true,

          ipAddress:
            true,

          active:
            true,

          cpuCores:
            true,

          ramGb:
            true,

          diskGb:
            true,

          companyId:
            true,

          company: {
            select: {
              id:
                true,

              name:
                true,
            },
          },

          operatingSystem: {
            select: {
              id:
                true,

              name:
                true,

              version:
                true,
            },
          },

          software: {
            select: {
              softwareId:
                true,

              version:
                true,

              software: {
                select: {
                  id:
                    true,

                  name:
                    true,
                },
              },
            },
          },
        },
      });

    const filteredTotal =
      servers.length;

    const filteredActive =
      servers.filter(
        (server) =>
          server.active,
      ).length;

    const filteredInactive =
      filteredTotal -
      filteredActive;

    const resources =
      servers.reduce(
        (
          accumulator,
          server,
        ) => {
          accumulator.cpuCores +=
            server.cpuCores ??
            0;

          accumulator.ramGb +=
            server.ramGb ??
            0;

          accumulator.diskGb +=
            server.diskGb ??
            0;

          return accumulator;
        },
        {
          cpuCores:
            0,

          ramGb:
            0,

          diskGb:
            0,
        },
      );

    const quality = {
      missingIp:
        servers.filter(
          (server) =>
            !server.ipAddress,
        ).length,

      missingOperatingSystem:
        servers.filter(
          (server) =>
            !server.operatingSystem,
        ).length,

      incompleteResources:
        servers.filter(
          (server) =>
            server.cpuCores === null ||
            server.ramGb === null ||
            server.diskGb === null,
        ).length,

      missingSoftware:
        servers.filter(
          (server) =>
            server.software.length === 0,
        ).length,
    };

    const completeInventory =
      servers.filter(
        (server) =>
          Boolean(server.ipAddress) &&
          Boolean(server.operatingSystem) &&
          server.cpuCores !== null &&
          server.ramGb !== null &&
          server.diskGb !== null &&
          server.software.length > 0,
      ).length;

    const issueCountDistribution = {
      zero: 0,
      one: 0,
      two: 0,
      threePlus: 0,
    };

    for (const server of servers) {
      const issueCount = [
        !server.ipAddress,
        !server.operatingSystem,
        server.cpuCores === null ||
          server.ramGb === null ||
          server.diskGb === null,
        server.software.length === 0,
      ].filter(Boolean).length;

      if (issueCount === 0) {
        issueCountDistribution.zero += 1;
      } else if (issueCount === 1) {
        issueCountDistribution.one += 1;
      } else if (issueCount === 2) {
        issueCountDistribution.two += 1;
      } else {
        issueCountDistribution.threePlus += 1;
      }
    }

    const completenessPercentage =
      filteredTotal === 0
        ? 0
        : Number(
            (
              (completeInventory /
                filteredTotal) *
              100
            ).toFixed(1),
          );

    const softwareVersionSpreadMap =
      new Map<
        number,
        {
          softwareId: number;
          name: string;
          versions: Set<string>;
          serverIds: Set<number>;
        }
      >();

    const operatingSystemsMap =
      new Map<
        string,
        {
          id: number;
          name: string;
          count: number;
        }
      >();

    const softwareMap =
      new Map<
        string,
        {
          id: number;
          name: string;
          version: string;
          count: number;
        }
      >();

    const companyMap =
      new Map<
        number,
        {
          id: number;
          name: string;
          count: number;
        }
      >();

    for (
      const server of servers
    ) {
      if (
        server.company
      ) {
        const existingCompany =
          companyMap.get(
            server.company.id,
          );

        if (
          existingCompany
        ) {
          existingCompany.count +=
            1;
        } else {
          companyMap.set(
            server.company.id,
            {
              id:
                server.company.id,

              name:
                server.company.name,

              count:
                1,
            },
          );
        }
      }

      if (
        server.operatingSystem
      ) {
        const key =
          `${server.operatingSystem.id}`;

        const name =
          `${server.operatingSystem.name} ${server.operatingSystem.version}`;

        const existingOperatingSystem =
          operatingSystemsMap.get(
            key,
          );

        if (
          existingOperatingSystem
        ) {
          existingOperatingSystem.count +=
            1;
        } else {
          operatingSystemsMap.set(
            key,
            {
              id:
                server.operatingSystem.id,

              name,

              count:
                1,
            },
          );
        }
      }

      for (
        const item of server.software
      ) {
        const spread =
          softwareVersionSpreadMap.get(
            item.softwareId,
          );

        if (spread) {
          spread.versions.add(
            item.version,
          );
          spread.serverIds.add(
            server.id,
          );
        } else {
          softwareVersionSpreadMap.set(
            item.softwareId,
            {
              softwareId:
                item.softwareId,

              name:
                item.software.name,

              versions:
                new Set([
                  item.version,
                ]),

              serverIds:
                new Set([
                  server.id,
                ]),
            },
          );
        }

        const key =
          `${item.softwareId}:${item.version}`;

        const name =
          `${item.software.name} ${item.version}`;

        const existingSoftware =
          softwareMap.get(
            key,
          );

        if (
          existingSoftware
        ) {
          existingSoftware.count +=
            1;
        } else {
          softwareMap.set(
            key,
            {
              id:
                item.software.id,

              name,

              version:
                item.version,

              count:
                1,
            },
          );
        }
      }
    }

    const operatingSystems =
      Array.from(
        operatingSystemsMap.values(),
      ).sort(
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

    const software =
      Array.from(
        softwareMap.values(),
      ).sort(
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

    const companies =
      Array.from(
        companyMap.values(),
      ).sort(
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

    const softwareVersionSpread =
      Array.from(
        softwareVersionSpreadMap.values(),
      )
        .filter(
          (item) =>
            item.versions.size >
            1,
        )
        .map(
          (item) => ({
            softwareId:
              item.softwareId,

            name:
              item.name,

            versions:
              Array.from(
                item.versions,
              ).sort(
                (
                  a,
                  b,
                ) =>
                  a.localeCompare(
                    b,
                    undefined,
                    {
                      numeric:
                        true,

                      sensitivity:
                        'base',
                    },
                  ),
              ),

            versionCount:
              item.versions.size,

            serverCount:
              item.serverIds.size,
          }),
        )
        .sort(
          (
            a,
            b,
          ) =>
            b.versionCount -
              a.versionCount ||
            b.serverCount -
              a.serverCount ||
            a.name.localeCompare(
              b.name,
            ),
        );

    const serverIds =
      servers.map(
        (server) =>
          server.id,
      );

    const recentActivity =
      serverIds.length ===
      0
        ? []
        : await this.prisma.auditLog.findMany({
            where: {
              entityType:
                'SERVER',

              entityId: {
                in:
                  serverIds,
              },
            },

            select: {
              id:
                true,

              action:
                true,

              entityId:
                true,

              entityName:
                true,

              details:
                true,

              createdAt:
                true,

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
                },
              },
            },

            orderBy: {
              createdAt:
                'desc',
            },

            take:
              8,
          });

    return {
      selectedEnvironment:
        environment ??
        null,

      selectedCompanyId:
        requestedCompanyId ??
        null,

      totals: {
        servers:
          totalServers,

        active:
          activeServers,

        inactive:
          totalServers -
          activeServers,

        prd:
          prdServers,

        qas:
          qasServers,

        dev:
          devServers,

        filtered:
          filteredTotal,

        filteredActive,

        filteredInactive,
      },

      resources,

      quality: {
        ...quality,

        completeInventory,

        completenessPercentage,

        issueCountDistribution,
      },

      softwareVersionSpread,

      operatingSystems,

      software,

      companies,

      recentActivity:
        recentActivity.map(
          (item) => {
            const details =
              item.details &&
              typeof item.details ===
                'object' &&
              !Array.isArray(
                item.details,
              )
                ? item.details as
                    Prisma.JsonObject
                : null;

            const message =
              typeof details?.[
                'message'
              ] ===
                'string'
                ? details[
                    'message'
                  ] as string
                : item.action;

            return {
              id:
                item.id,

              action:
                item.action,

              entityId:
                item.entityId,

              entityName:
                item.entityName,

              message,

              createdAt:
                item.createdAt,

              user:
                item.user,

              company:
                item.company,
            };
          },
        ),
    };
  }
}
