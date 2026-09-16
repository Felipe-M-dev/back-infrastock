import {
  Injectable,
} from '@nestjs/common';

import type {
  JwtPayload,
} from '../auth/jwt-auth.guard.js';

import {
  buildScopedServerCompanyWhere,
} from '../company-scope/company-scope.js';

import { PrismaService } from '../prisma/prisma.service.js';
import { EndOfLifeService } from './endoflife.service.js';

export interface OperatingSystemLifecycleFilters {
  companyId?: number;
  environment?:
    | 'PRD'
    | 'QAS'
    | 'DEV';
}

@Injectable()
export class OperatingSystemLifecycleService {
  constructor(
    private readonly prisma:
      PrismaService,

    private readonly endOfLifeService:
      EndOfLifeService,
  ) {}

  async findInventory(
    currentUser: JwtPayload,
    filters:
      OperatingSystemLifecycleFilters = {},
  ) {
    const serverWhere =
      await buildScopedServerCompanyWhere(
        this.prisma,
        currentUser,
        filters.companyId,
      );

    if (
      filters.environment
    ) {
      serverWhere.environment =
        filters.environment;
    }

    const servers =
      await this.prisma.server.findMany({
        where: serverWhere,

        select: {
          id: true,
          environment: true,

          company: {
            select: {
              id: true,
              name: true,
            },
          },

          operatingSystem: {
            select: {
              id: true,
              name: true,
              version: true,
              active: true,
              eolProductKey: true,
            },
          },
        },
      });

    type OperatingSystemAccumulator = {
      operatingSystemId: number;
      name: string;
      version: string;
      active: boolean;
      configuredProductKey:
        string | null;
      serverIds: Set<number>;
      companies:
        Map<number, string>;
      environments:
        Set<string>;
    };

    const grouped =
      new Map<
        number,
        OperatingSystemAccumulator
      >();

    for (
      const server of
      servers
    ) {
      const operatingSystem =
        server.operatingSystem;

      if (!operatingSystem) {
        continue;
      }

      let entry =
        grouped.get(
          operatingSystem.id,
        );

      if (!entry) {
        entry = {
          operatingSystemId:
            operatingSystem.id,
          name:
            operatingSystem.name,
          version:
            operatingSystem.version,
          active:
            operatingSystem.active,
          configuredProductKey:
            operatingSystem.eolProductKey,
          serverIds:
            new Set<number>(),
          companies:
            new Map<number, string>(),
          environments:
            new Set<string>(),
        };

        grouped.set(
          operatingSystem.id,
          entry,
        );
      }

      entry.serverIds.add(
        server.id,
      );

      if (
        server.company
      ) {
        entry.companies.set(
          server.company.id,
          server.company.name,
        );
      }

      if (
        server.environment
      ) {
        entry.environments.add(
          server.environment,
        );
      }
    }

    const internalItems =
      await Promise.all(
        Array.from(
          grouped.values(),
        ).map(
          async (item) => {
            const endOfLife =
              await this.endOfLifeService.analyzeOperatingSystem(
                item.name,
                [
                  item.version,
                ],
                item.configuredProductKey,
              );

            return {
              ...item,
              endOfLife,
            };
          },
        ),
      );

    internalItems.sort(
      (left, right) => {
        const byName =
          left.name.localeCompare(
            right.name,
            undefined,
            {
              sensitivity:
                'base',
            },
          );

        if (byName !== 0) {
          return byName;
        }

        return left.version.localeCompare(
          right.version,
          undefined,
          {
            numeric: true,
            sensitivity:
              'base',
          },
        );
      },
    );

    const eolServerIds =
      new Set<number>();

    const eolSoonServerIds =
      new Set<number>();

    let eol = 0;
    let eolSoon = 0;
    let supported = 0;
    let unknown = 0;

    for (
      const item of
      internalItems
    ) {
      const status =
        item.endOfLife
          .versions[0]
          ?.status ??
        'UNKNOWN';

      if (status === 'EOL') {
        eol += 1;

        for (
          const serverId of
          item.serverIds
        ) {
          eolServerIds.add(
            serverId,
          );
        }
      } else if (
        status === 'EOL_SOON'
      ) {
        eolSoon += 1;

        for (
          const serverId of
          item.serverIds
        ) {
          eolSoonServerIds.add(
            serverId,
          );
        }
      } else if (
        status === 'SUPPORTED'
      ) {
        supported += 1;
      } else {
        unknown += 1;
      }
    }

    const operatingSystemNames =
      new Set(
        internalItems.map(
          (item) =>
            item.name,
        ),
      );

    const serversWithOperatingSystem =
      servers.filter(
        (server) =>
          server.operatingSystem !==
          null,
      ).length;

    return {
      selectedCompanyId:
        filters.companyId ??
        null,
      selectedEnvironment:
        filters.environment ??
        null,
      checkedAt:
        new Date().toISOString(),
      thresholdDays:
        this.endOfLifeService.getEolSoonDays(),
      totals: {
        servers:
          servers.length,
        serversWithOperatingSystem,
        operatingSystems:
          operatingSystemNames.size,
        versions:
          internalItems.length,
        eol,
        eolSoon,
        supported,
        unknown,
        eolServers:
          eolServerIds.size,
        eolSoonServers:
          eolSoonServerIds.size,
      },
      items:
        internalItems.map(
          (item) => ({
            operatingSystemId:
              item.operatingSystemId,
            name:
              item.name,
            version:
              item.version,
            active:
              item.active,
            configuredProductKey:
              item.configuredProductKey,
            serverCount:
              item.serverIds.size,
            companies:
              Array.from(
                item.companies.entries(),
              )
                .map(
                  ([id, name]) => ({
                    id,
                    name,
                  }),
                )
                .sort(
                  (left, right) =>
                    left.name.localeCompare(
                      right.name,
                      undefined,
                      {
                        sensitivity:
                          'base',
                      },
                    ),
                ),
            environments:
              Array.from(
                item.environments,
              ).sort(),
            endOfLife:
              item.endOfLife,
          }),
        ),
    };
  }
}
