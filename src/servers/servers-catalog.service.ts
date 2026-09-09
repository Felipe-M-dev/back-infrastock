import {
  Injectable,
} from '@nestjs/common';

import {
  Prisma,
} from '@prisma/client';

import type {
  JwtPayload,
} from '../auth/jwt-auth.guard.js';

import { PrismaService } from '../prisma/prisma.service.js';
import { buildScopedServerCompanyWhere } from '../company-scope/company-scope.js';
import { EndOfLifeService } from './endoflife.service.js';
import {
  calculateInventoryConfidence,
} from './inventory-confidence.js';

export interface SoftwareVersionFilters {
  softwareId: number;
  companyId?: number;
  environment?:
    | 'PRD'
    | 'QAS'
    | 'DEV';
}

export interface SoftwareVersionInventoryFilters {
  companyId?: number;
  environment?:
    | 'PRD'
    | 'QAS'
    | 'DEV';
}

@Injectable()
export class ServersCatalogService {
  constructor(
    private readonly prisma:
      PrismaService,

    private readonly endOfLifeService:
      EndOfLifeService,
  ) {}

  async findAll() {
    const [
      operatingSystems,
      software,
    ] = await Promise.all([
      this.prisma.operatingSystem.findMany({
        where: {
          active: true,
        },

        select: {
          id: true,
          name: true,
          version: true,
          active: true,
        },

        orderBy: [
          {
            name: 'asc',
          },

          {
            version: 'asc',
          },
        ],
      }),

      this.prisma.software.findMany({
        where: {
          active: true,
        },

        select: {
          id: true,
          name: true,
          active: true,
        },

        orderBy: {
          name: 'asc',
        },
      }),
    ]);

    return {
      operatingSystems,
      software,
    };
  }

  async findSoftwareVersions(
    currentUser: JwtPayload,
    filters: SoftwareVersionFilters,
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
          software: {
            where: {
              softwareId:
                filters.softwareId,
            },

            select: {
              version: true,
            },
          },
        },
      });

    const versions =
      Array.from(
        new Set(
          servers.flatMap(
            (server) =>
              server.software
                .map(
                  (item) =>
                    item.version.trim(),
                )
                .filter(
                  (version) =>
                    version.length > 0,
                ),
          ),
        ),
      ).sort((left, right) =>
        left.localeCompare(
          right,
          undefined,
          {
            numeric: true,
            sensitivity: 'base',
          },
        ),
      );

    return {
      softwareId:
        filters.softwareId,
      versions,
    };
  }

  async findSoftwareVersionInventory(
    currentUser: JwtPayload,
    filters:
      SoftwareVersionInventoryFilters = {},
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

          software: {
            select: {
              version: true,

              software: {
                select: {
                  id: true,
                  name: true,
                  active: true,
                },
              },
            },
          },
        },
      });

    type VersionAccumulator = {
      version: string;
      serverIds: Set<number>;
      companies: Map<number, string>;
      environments: Set<string>;
    };

    type SoftwareAccumulator = {
      softwareId: number;
      name: string;
      active: boolean;
      serverIds: Set<number>;
      companies: Map<number, string>;
      environments: Set<string>;
      versions: Map<string, VersionAccumulator>;
    };

    const grouped =
      new Map<number, SoftwareAccumulator>();

    for (
      const server of
      servers
    ) {
      for (
        const installation of
        server.software
      ) {
        const version =
          installation.version.trim();

        if (!version) {
          continue;
        }

        const software =
          installation.software;

        let softwareEntry =
          grouped.get(
            software.id,
          );

        if (
          !softwareEntry
        ) {
          softwareEntry = {
            softwareId:
              software.id,
            name:
              software.name,
            active:
              software.active,
            serverIds:
              new Set<number>(),
            companies:
              new Map<number, string>(),
            environments:
              new Set<string>(),
            versions:
              new Map<string, VersionAccumulator>(),
          };

          grouped.set(
            software.id,
            softwareEntry,
          );
        }

        softwareEntry.serverIds.add(
          server.id,
        );

        if (
          server.company
        ) {
          softwareEntry.companies.set(
            server.company.id,
            server.company.name,
          );
        }

        if (
          server.environment
        ) {
          softwareEntry.environments.add(
            server.environment,
          );
        }

        let versionEntry =
          softwareEntry.versions.get(
            version,
          );

        if (
          !versionEntry
        ) {
          versionEntry = {
            version,
            serverIds:
              new Set<number>(),
            companies:
              new Map<number, string>(),
            environments:
              new Set<string>(),
          };

          softwareEntry.versions.set(
            version,
            versionEntry,
          );
        }

        versionEntry.serverIds.add(
          server.id,
        );

        if (
          server.company
        ) {
          versionEntry.companies.set(
            server.company.id,
            server.company.name,
          );
        }

        if (
          server.environment
        ) {
          versionEntry.environments.add(
            server.environment,
          );
        }
      }
    }

    const compareVersions = (
      left: string,
      right: string,
    ) =>
      left.localeCompare(
        right,
        undefined,
        {
          numeric: true,
          sensitivity: 'base',
        },
      );

    const items =
      Array.from(
        grouped.values(),
      )
        .map(
          (item) => {
            const versions =
              Array.from(
                item.versions.values(),
              )
                .map(
                  (version) => ({
                    version:
                      version.version,
                    serverCount:
                      version.serverIds.size,
                    companies:
                      Array.from(
                        version.companies.entries(),
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
                                sensitivity: 'base',
                              },
                            ),
                        ),
                    environments:
                      Array.from(
                        version.environments,
                      ).sort(),
                  }),
                )
                .sort(
                  (left, right) =>
                    compareVersions(
                      left.version,
                      right.version,
                    ),
                );

            return {
              softwareId:
                item.softwareId,
              name:
                item.name,
              active:
                item.active,
              serverCount:
                item.serverIds.size,
              versionCount:
                versions.length,
              hasMultipleVersions:
                versions.length > 1,
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
                          sensitivity: 'base',
                        },
                      ),
                  ),
              environments:
                Array.from(
                  item.environments,
                ).sort(),
              versions,
            };
          },
        )
        .sort(
          (left, right) =>
            left.name.localeCompare(
              right.name,
              undefined,
              {
                sensitivity: 'base',
              },
            ),
        );

    const enrichedItems =
      await Promise.all(
        items.map(
          async (item) => ({
            ...item,
            endOfLife:
              await this.endOfLifeService.analyzeSoftware(
                item.name,
                item.versions.map(
                  (version) =>
                    version.version,
                ),
              ),
          }),
        ),
      );

    return {
      selectedCompanyId:
        filters.companyId ??
        null,
      selectedEnvironment:
        filters.environment ??
        null,
      totals: {
        software:
          enrichedItems.length,
        versions:
          enrichedItems.reduce(
            (total, item) =>
              total +
              item.versionCount,
            0,
          ),
        multipleVersionSoftware:
          enrichedItems.filter(
            (item) =>
              item.hasMultipleVersions,
          ).length,
        servers:
          servers.length,
      },
      items:
        enrichedItems,
    };
  }

  async findSoftwareSupportSummary(
    currentUser: JwtPayload,
    filters:
      SoftwareVersionInventoryFilters = {},
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

          software: {
            select: {
              version: true,

              software: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });

    const versionsBySoftware =
      new Map<string, Set<string>>();

    for (
      const server of
      servers
    ) {
      for (
        const installation of
        server.software
      ) {
        const version =
          installation.version.trim();

        if (!version) {
          continue;
        }

        const name =
          installation.software.name;

        const versions =
          versionsBySoftware.get(
            name,
          ) ??
          new Set<string>();

        versions.add(
          version,
        );

        versionsBySoftware.set(
          name,
          versions,
        );
      }
    }

    const analysisBySoftware =
      new Map<
        string,
        Awaited<
          ReturnType<
            EndOfLifeService['analyzeSoftware']
          >
        >
      >();

    await Promise.all(
      Array.from(
        versionsBySoftware.entries(),
      ).map(
        async ([name, versions]) => {
          const analysis =
            await this.endOfLifeService.analyzeSoftware(
              name,
              Array.from(versions),
            );

          analysisBySoftware.set(
            name,
            analysis,
          );
        },
      ),
    );

    const eolServerIds =
      new Set<number>();

    const eolSoonServerIds =
      new Set<number>();

    const supportedServerIds =
      new Set<number>();

    const unknownServerIds =
      new Set<number>();

    for (
      const server of
      servers
    ) {
      let hasKnownStatus =
        false;

      for (
        const installation of
        server.software
      ) {
        const analysis =
          analysisBySoftware.get(
            installation.software.name,
          );

        const versionStatus =
          analysis?.versions.find(
            (item) =>
              item.installedVersion ===
              installation.version.trim(),
          );

        if (!versionStatus) {
          unknownServerIds.add(
            server.id,
          );
          continue;
        }

        if (
          versionStatus.status ===
          'EOL'
        ) {
          hasKnownStatus =
            true;

          eolServerIds.add(
            server.id,
          );
        } else if (
          versionStatus.status ===
          'EOL_SOON'
        ) {
          hasKnownStatus =
            true;

          eolSoonServerIds.add(
            server.id,
          );
        } else if (
          versionStatus.status ===
          'SUPPORTED'
        ) {
          hasKnownStatus =
            true;

          supportedServerIds.add(
            server.id,
          );
        } else {
          unknownServerIds.add(
            server.id,
          );
        }
      }

      if (
        server.software.length > 0 &&
        !hasKnownStatus
      ) {
        unknownServerIds.add(
          server.id,
        );
      }
    }

    const mappedProducts =
      Array.from(
        analysisBySoftware.values(),
      ).filter(
        (analysis) =>
          analysis.product !==
          null,
      );

    const availableProducts =
      mappedProducts.filter(
        (analysis) =>
          analysis.status ===
          'AVAILABLE',
      ).length;

    const unavailableProducts =
      mappedProducts.filter(
        (analysis) =>
          analysis.status ===
          'UNAVAILABLE',
      ).length;

    const notConfiguredProducts =
      Array.from(
        analysisBySoftware.values(),
      ).filter(
        (analysis) =>
          analysis.status ===
          'NOT_CONFIGURED',
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

        serversWithSoftware:
          servers.filter(
            (server) =>
              server.software.length > 0,
          ).length,

        eol:
          eolServerIds.size,

        eolSoon:
          eolSoonServerIds.size,

        supported:
          supportedServerIds.size,

        unknown:
          unknownServerIds.size,

        mappedProducts:
          mappedProducts.length,

        availableProducts,

        unavailableProducts,

        notConfiguredProducts,
      },
    };
  }

  async findSoftwareUpdatePriorities(
    currentUser: JwtPayload,
    filters:
      SoftwareVersionInventoryFilters = {},
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

          software: {
            select: {
              softwareId: true,
              version: true,

              software: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });

    const versionsBySoftware =
      new Map<
        string,
        Set<string>
      >();

    for (
      const server of
      servers
    ) {
      for (
        const installation of
        server.software
      ) {
        const version =
          installation.version.trim();

        if (!version) {
          continue;
        }

        const name =
          installation.software.name;

        const versions =
          versionsBySoftware.get(
            name,
          ) ??
          new Set<string>();

        versions.add(
          version,
        );

        versionsBySoftware.set(
          name,
          versions,
        );
      }
    }

    const analysisBySoftware =
      new Map<
        string,
        Awaited<
          ReturnType<
            EndOfLifeService['analyzeSoftware']
          >
        >
      >();

    await Promise.all(
      Array.from(
        versionsBySoftware.entries(),
      ).map(
        async ([name, versions]) => {
          const analysis =
            await this.endOfLifeService.analyzeSoftware(
              name,
              Array.from(versions),
            );

          analysisBySoftware.set(
            name,
            analysis,
          );
        },
      ),
    );

    type Priority =
      | 'CRITICAL'
      | 'HIGH'
      | 'MEDIUM';

    const impactMap =
      new Map<
        string,
        {
          softwareId: number;
          name: string;
          installedVersion: string;
          serverIds: Set<number>;
          prdServerIds: Set<number>;
          qasServerIds: Set<number>;
          devServerIds: Set<number>;
          companies: Map<
            number,
            {
              id: number;
              name: string;
              serverIds: Set<number>;
            }
          >;
        }
      >();

    for (
      const server of
      servers
    ) {
      for (
        const installation of
        server.software
      ) {
        const installedVersion =
          installation.version.trim();

        if (!installedVersion) {
          continue;
        }

        const softwareName =
          installation.software.name;

        const analysis =
          analysisBySoftware.get(
            softwareName,
          );

        const versionStatus =
          analysis?.versions.find(
            (item) =>
              item.installedVersion ===
              installedVersion,
          );

        if (
          !versionStatus ||
          ![
            'EOL',
            'EOL_SOON',
          ].includes(
            versionStatus.status,
          )
        ) {
          continue;
        }

        const key =
          `${installation.softwareId}\u0000${installedVersion}`;

        let impact =
          impactMap.get(key);

        if (!impact) {
          impact = {
            softwareId:
              installation.softwareId,
            name:
              softwareName,
            installedVersion,
            serverIds:
              new Set<number>(),
            prdServerIds:
              new Set<number>(),
            qasServerIds:
              new Set<number>(),
            devServerIds:
              new Set<number>(),
            companies:
              new Map(),
          };

          impactMap.set(
            key,
            impact,
          );
        }

        impact.serverIds.add(
          server.id,
        );

        if (
          server.environment ===
          'PRD'
        ) {
          impact.prdServerIds.add(
            server.id,
          );
        } else if (
          server.environment ===
          'QAS'
        ) {
          impact.qasServerIds.add(
            server.id,
          );
        } else if (
          server.environment ===
          'DEV'
        ) {
          impact.devServerIds.add(
            server.id,
          );
        }

        if (server.company) {
          const companyEntry =
            impact.companies.get(
              server.company.id,
            ) ?? {
              id:
                server.company.id,
              name:
                server.company.name,
              serverIds:
                new Set<number>(),
            };

          companyEntry.serverIds.add(
            server.id,
          );

          impact.companies.set(
            server.company.id,
            companyEntry,
          );
        }
      }
    }

    const priorityRank:
      Record<Priority, number> = {
        CRITICAL: 0,
        HIGH: 1,
        MEDIUM: 2,
      };

    const items =
      Array.from(
        impactMap.values(),
      )
        .map((impact) => {
          const analysis =
            analysisBySoftware.get(
              impact.name,
            );

          const support =
            analysis?.versions.find(
              (item) =>
                item.installedVersion ===
                impact.installedVersion,
            );

          if (
            !support ||
            (
              support.status !== 'EOL' &&
              support.status !== 'EOL_SOON'
            )
          ) {
            return null;
          }

          let priority:
            Priority;

          if (
            support.status === 'EOL' &&
            impact.prdServerIds.size > 0
          ) {
            priority =
              'CRITICAL';
          } else if (
            support.status === 'EOL' ||
            impact.prdServerIds.size > 0
          ) {
            priority =
              'HIGH';
          } else {
            priority =
              'MEDIUM';
          }

          return {
            softwareId:
              impact.softwareId,
            name:
              impact.name,
            installedVersion:
              impact.installedVersion,
            cycle:
              support.cycle,
            status:
              support.status,
            priority,
            eolDate:
              support.eolDate,
            daysToEol:
              support.daysToEol,
            latestInCycle:
              support.latestInCycle,
            isLts:
              support.isLts,
            serverCount:
              impact.serverIds.size,
            prdServers:
              impact.prdServerIds.size,
            qasServers:
              impact.qasServerIds.size,
            devServers:
              impact.devServerIds.size,
            companies:
              Array.from(
                impact.companies.values(),
              )
                .map(
                  (company) => ({
                    id:
                      company.id,
                    name:
                      company.name,
                    serverCount:
                      company.serverIds.size,
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
            recommendation:
              analysis?.recommendation ??
              null,
          };
        })
        .filter(
          (
            item,
          ): item is NonNullable<
            typeof item
          > =>
            item !== null,
        )
        .sort((left, right) => {
          const rankDifference =
            priorityRank[
              left.priority
            ] -
            priorityRank[
              right.priority
            ];

          if (
            rankDifference !== 0
          ) {
            return rankDifference;
          }

          if (
            left.status === 'EOL' &&
            right.status === 'EOL' &&
            left.daysToEol !== null &&
            right.daysToEol !== null &&
            left.daysToEol !==
              right.daysToEol
          ) {
            return (
              left.daysToEol -
              right.daysToEol
            );
          }

          if (
            left.status === 'EOL_SOON' &&
            right.status === 'EOL_SOON' &&
            left.daysToEol !== null &&
            right.daysToEol !== null &&
            left.daysToEol !==
              right.daysToEol
          ) {
            return (
              left.daysToEol -
              right.daysToEol
            );
          }

          if (
            left.prdServers !==
            right.prdServers
          ) {
            return (
              right.prdServers -
              left.prdServers
            );
          }

          if (
            left.serverCount !==
            right.serverCount
          ) {
            return (
              right.serverCount -
              left.serverCount
            );
          }

          const nameDifference =
            left.name.localeCompare(
              right.name,
              undefined,
              {
                sensitivity:
                  'base',
              },
            );

          if (
            nameDifference !== 0
          ) {
            return nameDifference;
          }

          return left.installedVersion.localeCompare(
            right.installedVersion,
            undefined,
            {
              numeric: true,
              sensitivity:
                'base',
            },
          );
        });

    const affectedServerIds =
      new Set<number>();

    for (
      const impact of
      impactMap.values()
    ) {
      for (
        const serverId of
        impact.serverIds
      ) {
        affectedServerIds.add(
          serverId,
        );
      }
    }

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
        critical:
          items.filter(
            (item) =>
              item.priority ===
              'CRITICAL',
          ).length,
        high:
          items.filter(
            (item) =>
              item.priority ===
              'HIGH',
          ).length,
        medium:
          items.filter(
            (item) =>
              item.priority ===
              'MEDIUM',
          ).length,
        affectedVersions:
          items.length,
        affectedServers:
          affectedServerIds.size,
      },

      items,
    };
  }

  async findInventoryFreshnessSummary(
    currentUser: JwtPayload,
    filters:
      SoftwareVersionInventoryFilters = {},
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
        where:
          serverWhere,

        select: {
          id: true,
          hostname: true,
          updatedAt: true,
          environment: true,

          company: {
            select: {
              id: true,
              name: true,
            },
          },
        },

        orderBy: {
          updatedAt:
            'asc',
        },
      });

    const now =
      new Date();

    const ageDays = (
      value: Date,
    ) =>
      Math.max(
        0,
        Math.floor(
          (
            now.getTime() -
            value.getTime()
          ) /
            (24 * 60 * 60 * 1000),
        ),
      );

    let recent = 0;
    let days30to59 = 0;
    let days60to89 = 0;
    let days90plus = 0;

    for (
      const server of
      servers
    ) {
      const age =
        ageDays(
          server.updatedAt,
        );

      if (age < 30) {
        recent += 1;
      } else if (age < 60) {
        days30to59 += 1;
      } else if (age < 90) {
        days60to89 += 1;
      } else {
        days90plus += 1;
      }
    }

    const total =
      servers.length;

    const stale30plus =
      days30to59 +
      days60to89 +
      days90plus;

    const freshnessPercentage =
      total === 0
        ? 0
        : Number(
            (
              (recent / total) *
              100
            ).toFixed(1),
          );

    const oldest =
      servers.length > 0
        ? {
            id:
              servers[0].id,
            hostname:
              servers[0].hostname,
            updatedAt:
              servers[0].updatedAt.toISOString(),
            ageDays:
              ageDays(
                servers[0].updatedAt,
              ),
            environment:
              servers[0].environment,
            company:
              servers[0].company,
          }
        : null;

    return {
      selectedCompanyId:
        filters.companyId ??
        null,

      selectedEnvironment:
        filters.environment ??
        null,

      checkedAt:
        now.toISOString(),

      thresholds: {
        warningDays: 30,
        staleDays: 60,
        criticalDays: 90,
      },

      totals: {
        total,
        recent,
        days30to59,
        days60to89,
        days90plus,
        stale30plus,
        freshnessPercentage,
      },

      oldest,
    };
  }


  async findInventoryConfidenceSummary(
    currentUser: JwtPayload,
    filters:
      SoftwareVersionInventoryFilters = {},
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
        where:
          serverWhere,

        select: {
          id:
            true,

          hostname:
            true,

          ipAddress:
            true,

          operatingSystemId:
            true,

          cpuCores:
            true,

          ramGb:
            true,

          diskGb:
            true,

          updatedAt:
            true,

          environment:
            true,

          company: {
            select: {
              id:
                true,

              name:
                true,
            },
          },

          _count: {
            select: {
              software:
                true,
            },
          },
        },
      });

    const now =
      new Date();

    let high =
      0;

    let medium =
      0;

    let low =
      0;

    let totalScore =
      0;

    const evaluated =
      servers.map(
        (server) => {
          const confidence =
            calculateInventoryConfidence(
              {
                ipAddress:
                  server.ipAddress,

                operatingSystemId:
                  server.operatingSystemId,

                cpuCores:
                  server.cpuCores,

                ramGb:
                  server.ramGb,

                diskGb:
                  server.diskGb,

                updatedAt:
                  server.updatedAt,

                softwareCount:
                  server._count.software,
              },
              now,
            );

          totalScore +=
            confidence.score;

          if (
            confidence.level ===
            'HIGH'
          ) {
            high +=
              1;
          } else if (
            confidence.level ===
            'MEDIUM'
          ) {
            medium +=
              1;
          } else {
            low +=
              1;
          }

          return {
            id:
              server.id,

            hostname:
              server.hostname,

            environment:
              server.environment,

            company:
              server.company,

            updatedAt:
              server.updatedAt.toISOString(),

            ...confidence,
          };
        },
      );

    evaluated.sort(
      (
        left,
        right,
      ) =>
        left.score -
          right.score ||
        right.ageDays -
          left.ageDays ||
        left.hostname.localeCompare(
          right.hostname,
          undefined,
          {
            sensitivity:
              'base',
          },
        ),
    );

    const total =
      evaluated.length;

    const averageScore =
      total === 0
        ? 0
        : Number(
            (
              totalScore /
              total
            ).toFixed(
              1,
            ),
          );

    const reliablePercentage =
      total === 0
        ? 0
        : Number(
            (
              (high /
                total) *
              100
            ).toFixed(
              1,
            ),
          );

    const lowest =
      evaluated.length >
      0
        ? evaluated[0]
        : null;

    return {
      selectedCompanyId:
        filters.companyId ??
        null,

      selectedEnvironment:
        filters.environment ??
        null,

      checkedAt:
        now.toISOString(),

      scoring: {
        completenessMax:
          60,

        freshnessMax:
          40,

        issuePenalty:
          15,

        freshnessPoints: {
          recent:
            40,

          days30to59:
            30,

          days60to89:
            15,

          days90plus:
            0,
        },

        levels: {
          highMin:
            85,

          mediumMin:
            60,
        },
      },

      totals: {
        total,
        high,
        medium,
        low,
        averageScore,
        reliablePercentage,
      },

      lowest,
    };
  }


  async findInventoryReviewPriorities(
    currentUser: JwtPayload,
    filters:
      SoftwareVersionInventoryFilters = {},
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
        where:
          serverWhere,

        select: {
          id:
            true,

          hostname:
            true,

          ipAddress:
            true,

          operatingSystemId:
            true,

          cpuCores:
            true,

          ramGb:
            true,

          diskGb:
            true,

          updatedAt:
            true,

          environment:
            true,

          company: {
            select: {
              id:
                true,

              name:
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
                  name:
                    true,
                },
              },
            },
          },

          _count: {
            select: {
              software:
                true,
            },
          },
        },
      });

    const versionsBySoftware =
      new Map<
        string,
        Set<string>
      >();

    for (
      const server
      of servers
    ) {
      for (
        const installation
        of server.software
      ) {
        const version =
          installation.version.trim();

        if (!version) {
          continue;
        }

        const name =
          installation.software.name;

        const versions =
          versionsBySoftware.get(
            name,
          ) ??
          new Set<string>();

        versions.add(
          version,
        );

        versionsBySoftware.set(
          name,
          versions,
        );
      }
    }

    const analysisBySoftware =
      new Map<
        string,
        Awaited<
          ReturnType<
            EndOfLifeService['analyzeSoftware']
          >
        >
      >();

    await Promise.all(
      Array.from(
        versionsBySoftware.entries(),
      ).map(
        async (
          [
            name,
            versions,
          ],
        ) => {
          const analysis =
            await this.endOfLifeService.analyzeSoftware(
              name,
              Array.from(
                versions,
              ),
            );

          analysisBySoftware.set(
            name,
            analysis,
          );
        },
      ),
    );

    type ReviewPriority =
      | 'CRITICAL'
      | 'HIGH'
      | 'MEDIUM';

    const now =
      new Date();

    const items =
      servers
        .map(
          (server) => {
            const confidence =
              calculateInventoryConfidence(
                {
                  ipAddress:
                    server.ipAddress,

                  operatingSystemId:
                    server.operatingSystemId,

                  cpuCores:
                    server.cpuCores,

                  ramGb:
                    server.ramGb,

                  diskGb:
                    server.diskGb,

                  updatedAt:
                    server.updatedAt,

                  softwareCount:
                    server._count.software,
                },
                now,
              );

            const softwareRisks =
              server.software
                .map(
                  (installation) => {
                    const installedVersion =
                      installation.version.trim();

                    if (
                      !installedVersion
                    ) {
                      return null;
                    }

                    const analysis =
                      analysisBySoftware.get(
                        installation.software.name,
                      );

                    const versionStatus =
                      analysis?.versions.find(
                        (item) =>
                          item.installedVersion ===
                          installedVersion,
                      );

                    if (
                      !versionStatus ||
                      (
                        versionStatus.status !==
                          'EOL' &&
                        versionStatus.status !==
                          'EOL_SOON'
                      )
                    ) {
                      return null;
                    }

                    return {
                      softwareId:
                        installation.softwareId,

                      name:
                        installation.software.name,

                      installedVersion,

                      status:
                        versionStatus.status as
                          | 'EOL'
                          | 'EOL_SOON',

                      eolDate:
                        versionStatus.eolDate,

                      daysToEol:
                        versionStatus.daysToEol,

                      latestInCycle:
                        versionStatus.latestInCycle,
                    };
                  },
                )
                .filter(
                  (
                    item,
                  ): item is NonNullable<
                    typeof item
                  > =>
                    item !== null,
                );

            const hasEol =
              softwareRisks.some(
                (item) =>
                  item.status ===
                  'EOL',
              );

            const hasEolSoon =
              softwareRisks.some(
                (item) =>
                  item.status ===
                  'EOL_SOON',
              );

            const needsReview =
              confidence.level !==
                'HIGH' ||
              confidence.ageDays >=
                60 ||
              hasEol ||
              hasEolSoon;

            if (
              !needsReview
            ) {
              return null;
            }

            let priority:
              ReviewPriority;

            if (
              server.environment ===
                'PRD' &&
              (
                confidence.level ===
                  'LOW' ||
                confidence.ageDays >=
                  90 ||
                hasEol
              )
            ) {
              priority =
                'CRITICAL';
            } else if (
              confidence.level ===
                'LOW' ||
              confidence.ageDays >=
                90 ||
              hasEol ||
              (
                server.environment ===
                  'PRD' &&
                (
                  confidence.level ===
                    'MEDIUM' ||
                  confidence.ageDays >=
                    60 ||
                  hasEolSoon
                )
              )
            ) {
              priority =
                'HIGH';
            } else {
              priority =
                'MEDIUM';
            }

            let reviewScore =
              0;

            if (
              server.environment ===
              'PRD'
            ) {
              reviewScore +=
                20;
            }

            if (
              confidence.level ===
              'LOW'
            ) {
              reviewScore +=
                35;
            } else if (
              confidence.level ===
              'MEDIUM'
            ) {
              reviewScore +=
                15;
            }

            if (
              confidence.ageDays >=
              90
            ) {
              reviewScore +=
                25;
            } else if (
              confidence.ageDays >=
              60
            ) {
              reviewScore +=
                15;
            }

            if (
              hasEol
            ) {
              reviewScore +=
                30;
            } else if (
              hasEolSoon
            ) {
              reviewScore +=
                15;
            }

            reviewScore +=
              confidence.issueCount *
              5;

            const reasons:
              string[] = [];

            if (
              confidence.level ===
              'LOW'
            ) {
              reasons.push(
                `Confiabilidad baja (${confidence.score}/100)`,
              );
            } else if (
              confidence.level ===
              'MEDIUM'
            ) {
              reasons.push(
                `Confiabilidad media (${confidence.score}/100)`,
              );
            }

            if (
              confidence.ageDays >=
              90
            ) {
              reasons.push(
                `Inventario sin actualizar hace ${confidence.ageDays} días`,
              );
            } else if (
              confidence.ageDays >=
              60
            ) {
              reasons.push(
                `Inventario con ${confidence.ageDays} días de antigüedad`,
              );
            }

            if (
              hasEol
            ) {
              reasons.push(
                'Tiene software fuera de soporte',
              );
            }

            if (
              hasEolSoon
            ) {
              reasons.push(
                'Tiene software próximo a EOL',
              );
            }

            if (
              server.environment ===
              'PRD'
            ) {
              reasons.push(
                'Servidor productivo',
              );
            }

            return {
              id:
                server.id,

              hostname:
                server.hostname,

              company:
                server.company,

              environment:
                server.environment,

              updatedAt:
                server.updatedAt.toISOString(),

              priority,

              reviewScore,

              confidence: {
                score:
                  confidence.score,

                level:
                  confidence.level,

                issueCount:
                  confidence.issueCount,

                ageDays:
                  confidence.ageDays,

                completenessPoints:
                  confidence.completenessPoints,

                freshnessPoints:
                  confidence.freshnessPoints,
              },

              support: {
                hasEol,
                hasEolSoon,
                software:
                  softwareRisks,
              },

              reasons,
            };
          },
        )
        .filter(
          (
            item,
          ): item is NonNullable<
            typeof item
          > =>
            item !== null,
        );

    const priorityRank:
      Record<
        ReviewPriority,
        number
      > = {
        CRITICAL: 0,
        HIGH: 1,
        MEDIUM: 2,
      };

    items.sort(
      (
        left,
        right,
      ) =>
        priorityRank[
          left.priority
        ] -
          priorityRank[
            right.priority
          ] ||
        right.reviewScore -
          left.reviewScore ||
        left.confidence.score -
          right.confidence.score ||
        right.confidence.ageDays -
          left.confidence.ageDays ||
        left.hostname.localeCompare(
          right.hostname,
          undefined,
          {
            sensitivity:
              'base',
          },
        ),
    );

    const critical =
      items.filter(
        (item) =>
          item.priority ===
          'CRITICAL',
      ).length;

    const high =
      items.filter(
        (item) =>
          item.priority ===
          'HIGH',
      ).length;

    const medium =
      items.filter(
        (item) =>
          item.priority ===
          'MEDIUM',
      ).length;

    return {
      selectedCompanyId:
        filters.companyId ??
        null,

      selectedEnvironment:
        filters.environment ??
        null,

      checkedAt:
        now.toISOString(),

      rules: {
        critical:
          'PRD con confiabilidad baja, 90+ días de antigüedad o software EOL',

        high:
          'Confiabilidad baja, 90+ días, software EOL, o PRD con confiabilidad media/60+ días/EOL próximo',

        medium:
          'Resto de servidores que requieren revisión por confiabilidad media, 60+ días o EOL próximo',
      },

      totals: {
        critical,
        high,
        medium,
        reviewRequired:
          items.length,
      },

      items,
    };
  }


  async findTechnologyRisk(
    currentUser: JwtPayload,
    filters:
      SoftwareVersionInventoryFilters = {},
  ) {
    const priorities =
      await this.findSoftwareUpdatePriorities(
        currentUser,
        filters,
      );

    type RiskLevel =
      | 'CRITICAL'
      | 'HIGH'
      | 'MEDIUM'
      | 'LOW';

    const companyMap =
      new Map<
        number,
        {
          id: number;
          name: string;
          affectedServers: number;
          criticalVersions: number;
          highVersions: number;
          mediumVersions: number;
          eolVersions: number;
          eolSoonVersions: number;
          exposurePoints: number;
        }
      >();

    const environmentMap =
      new Map<
        'PRD' | 'QAS' | 'DEV',
        {
          environment: 'PRD' | 'QAS' | 'DEV';
          affectedServers: number;
          criticalVersions: number;
          highVersions: number;
          mediumVersions: number;
          eolVersions: number;
          eolSoonVersions: number;
          exposurePoints: number;
        }
      >();

    const environmentCount = (
      item: (typeof priorities.items)[number],
      environment: 'PRD' | 'QAS' | 'DEV',
    ) => {
      if (environment === 'PRD') {
        return item.prdServers;
      }

      if (environment === 'QAS') {
        return item.qasServers;
      }

      return item.devServers;
    };

    const pointsFor = (
      priority: 'CRITICAL' | 'HIGH' | 'MEDIUM',
      affectedServers: number,
    ) => {
      const weight =
        priority === 'CRITICAL'
          ? 5
          : priority === 'HIGH'
            ? 3
            : 1;

      return weight * affectedServers;
    };

    for (const item of priorities.items) {
      for (const company of item.companies) {
        const current =
          companyMap.get(company.id) ?? {
            id: company.id,
            name: company.name,
            affectedServers: 0,
            criticalVersions: 0,
            highVersions: 0,
            mediumVersions: 0,
            eolVersions: 0,
            eolSoonVersions: 0,
            exposurePoints: 0,
          };

        current.affectedServers +=
          company.serverCount;
        current.exposurePoints +=
          pointsFor(
            item.priority,
            company.serverCount,
          );

        if (item.priority === 'CRITICAL') {
          current.criticalVersions += 1;
        } else if (item.priority === 'HIGH') {
          current.highVersions += 1;
        } else {
          current.mediumVersions += 1;
        }

        if (item.status === 'EOL') {
          current.eolVersions += 1;
        } else {
          current.eolSoonVersions += 1;
        }

        companyMap.set(
          company.id,
          current,
        );
      }

      for (
        const environment of
        ['PRD', 'QAS', 'DEV'] as const
      ) {
        const affectedServers =
          environmentCount(
            item,
            environment,
          );

        if (affectedServers === 0) {
          continue;
        }

        const current =
          environmentMap.get(environment) ?? {
            environment,
            affectedServers: 0,
            criticalVersions: 0,
            highVersions: 0,
            mediumVersions: 0,
            eolVersions: 0,
            eolSoonVersions: 0,
            exposurePoints: 0,
          };

        current.affectedServers +=
          affectedServers;
        current.exposurePoints +=
          pointsFor(
            item.priority,
            affectedServers,
          );

        if (item.priority === 'CRITICAL') {
          current.criticalVersions += 1;
        } else if (item.priority === 'HIGH') {
          current.highVersions += 1;
        } else {
          current.mediumVersions += 1;
        }

        if (item.status === 'EOL') {
          current.eolVersions += 1;
        } else {
          current.eolSoonVersions += 1;
        }

        environmentMap.set(
          environment,
          current,
        );
      }
    }

    const riskLevel = (
      criticalVersions: number,
      highVersions: number,
      mediumVersions: number,
    ): RiskLevel => {
      if (criticalVersions > 0) {
        return 'CRITICAL';
      }

      if (highVersions > 0) {
        return 'HIGH';
      }

      if (mediumVersions > 0) {
        return 'MEDIUM';
      }

      return 'LOW';
    };

    const byCompany =
      Array.from(companyMap.values())
        .map((item) => ({
          ...item,
          riskLevel: riskLevel(
            item.criticalVersions,
            item.highVersions,
            item.mediumVersions,
          ),
        }))
        .sort((left, right) =>
          right.exposurePoints -
            left.exposurePoints ||
          right.affectedServers -
            left.affectedServers ||
          left.name.localeCompare(
            right.name,
            undefined,
            { sensitivity: 'base' },
          ),
        );

    const byEnvironment =
      Array.from(environmentMap.values())
        .map((item) => ({
          ...item,
          riskLevel: riskLevel(
            item.criticalVersions,
            item.highVersions,
            item.mediumVersions,
          ),
        }))
        .sort((left, right) => {
          const environmentRank = {
            PRD: 0,
            QAS: 1,
            DEV: 2,
          };

          return (
            environmentRank[left.environment] -
            environmentRank[right.environment]
          );
        });

    return {
      selectedCompanyId:
        priorities.selectedCompanyId,
      selectedEnvironment:
        priorities.selectedEnvironment,
      checkedAt:
        priorities.checkedAt,
      thresholdDays:
        priorities.thresholdDays,
      totals: {
        affectedServers:
          priorities.totals.affectedServers,
        affectedVersions:
          priorities.totals.affectedVersions,
        companiesAtRisk:
          byCompany.length,
        criticalCompanies:
          byCompany.filter(
            (item) =>
              item.riskLevel === 'CRITICAL',
          ).length,
      },
      byCompany,
      byEnvironment,
    };
  }

}
