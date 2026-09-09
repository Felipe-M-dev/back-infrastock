import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import {
  buildScopedServerCompanyWhere,
  getAccessibleCompanies,
} from '../company-scope/company-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { CreatePricingTariffDto } from './dto/create-pricing-tariff.dto.js';
import type { ManualUfDto } from './dto/manual-uf.dto.js';
import type { UpdatePricingTariffDto } from './dto/update-pricing-tariff.dto.js';

interface CurrentUser {
  sub: number;
  username: string;
  role: Role;
  companyId: number | null;
}

interface ValuationTariff {
  id: number;
  code: string;
  category: string;
  name: string;
  unit: string;
  value: number;
  valueType: string;
  operatingSystemName: string | null;
  softwareId: number | null;
}

interface ValuationServer {
  id: number;
  hostname: string;
  environment: string | null;
  cpuCores: number | null;
  ramGb: number | null;
  diskGb: number | null;
  servicesOnitec: boolean;
  companyId: number | null;
  company: {
    id: number;
    name: string;
  } | null;
  operatingSystem: {
    id: number;
    name: string;
    version: string;
  } | null;
  software: Array<{
    softwareId: number;
    version: string;
    software: {
      id: number;
      name: string;
      category: string;
    };
  }>;
}

interface BcchObservation {
  indexDateString?: string;
  value?: string | number;
  statusCode?: string;
}

interface BcchResponse {
  Codigo?: number;
  Descripcion?: string;
  Series?: {
    seriesId?: string;
    Obs?: BcchObservation[];
  };
}

const UF_CODE = 'UF';

const PROTECTED_PRICING_TARIFF_CODES = new Set([
  'CPU_VCPU',
  'RAM_GB',
  'DISK_GB',
]);
const DEFAULT_BCCH_URL =
  'https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx';
const DEFAULT_UF_SERIES =
  'F073.UFF.PRE.Z.D';

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async getSummary() {
    const [
      uf,
      tariffs,
      operatingSystemNames,
      databaseSoftwareNames,
    ] = await Promise.all([
      this.getLatestUf(),
      this.getTariffs(),
      this.getOperatingSystemNames(),
      this.getDatabaseSoftwareNames(),
    ]);

    return {
      uf,
      tariffs,
      operatingSystemNames,
      databaseSoftwareNames,
      configuration: {
        bcchConfigured: Boolean(
          process.env.BCCH_API_TOKEN?.trim(),
        ),
        ufSeries:
          process.env.BCCH_UF_SERIES?.trim() ||
          DEFAULT_UF_SERIES,
      },
    };
  }

  async getLatestUf() {
    const indicator =
      await this.prisma.economicIndicator.findFirst({
        where: {
          code: UF_CODE,
        },
        orderBy: [
          {
            date: 'desc',
          },
          {
            fetchedAt: 'desc',
          },
        ],
      });

    if (!indicator) {
      return null;
    }

    return {
      id: indicator.id,
      code: indicator.code,
      date: indicator.date,
      value: Number(indicator.value),
      source: indicator.source,
      fetchedAt: indicator.fetchedAt,
    };
  }

  async getTariffs() {
    const tariffs =
      await this.prisma.pricingTariff.findMany({
        orderBy: [
          {
            category: 'asc',
          },
          {
            name: 'asc',
          },
        ],
      });

    return tariffs.map((tariff) => ({
      ...tariff,
      value: Number(tariff.value),
    }));
  }

  async getOperatingSystemNames() {
    const operatingSystems =
      await this.prisma.operatingSystem.findMany({
        where: {
          active: true,
        },
        select: {
          name: true,
        },
        distinct: ['name'],
        orderBy: {
          name: 'asc',
        },
      });

    return operatingSystems.map(
      (operatingSystem) =>
        operatingSystem.name,
    );
  }

  async getDatabaseSoftwareNames() {
    const software =
      await this.prisma.software.findMany({
        where: {
          active: true,
          category: 'DATABASE',
        },
        select: {
          name: true,
        },
        orderBy: {
          name: 'asc',
        },
      });

    return software.map(
      (item) => item.name,
    );
  }

  async refreshUf(
    currentUser: CurrentUser,
  ) {
    const token =
      process.env.BCCH_API_TOKEN?.trim();

    if (!token) {
      throw new BadRequestException(
        'BCCH_API_TOKEN no está configurado en el backend',
      );
    }

    const baseUrl =
      process.env.BCCH_API_URL?.trim() ||
      DEFAULT_BCCH_URL;

    const series =
      process.env.BCCH_UF_SERIES?.trim() ||
      DEFAULT_UF_SERIES;

    const timeoutMs =
      this.getPositiveIntegerEnv(
        'BCCH_TIMEOUT_MS',
        5000,
      );

    const today =
      this.getChileDateString(
        new Date(),
      );

    const startDate =
      new Date();

    startDate.setUTCDate(
      startDate.getUTCDate() - 10,
    );

    const firstDate =
      this.getChileDateString(
        startDate,
      );

    let url: URL;

    try {
      url = new URL(baseUrl);
    } catch {
      throw new BadRequestException(
        'BCCH_API_URL no contiene una URL válida',
      );
    }

    url.searchParams.set(
      'token',
      token,
    );
    url.searchParams.set(
      'function',
      'GetSeries',
    );
    url.searchParams.set(
      'timeseries',
      series,
    );
    url.searchParams.set(
      'firstdate',
      firstDate,
    );
    url.searchParams.set(
      'lastdate',
      today,
    );

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        timeoutMs,
      );

    try {
      const response =
        await fetch(
          url,
          {
            signal:
              controller.signal,
            headers: {
              Accept:
                'application/json',
            },
          },
        );

      if (!response.ok) {
        throw new BadGatewayException(
          `Banco Central respondió HTTP ${response.status}`,
        );
      }

      const payload =
        await response.json() as BcchResponse;

      if (payload.Codigo !== 0) {
        throw new BadGatewayException(
          payload.Descripcion ||
            'Banco Central rechazó la consulta',
        );
      }

      const observations =
        payload.Series?.Obs ?? [];

      const candidates =
        observations
          .filter(
            (item) =>
              !item.statusCode ||
              item.statusCode === 'OK',
          )
          .map((item) => ({
            date:
              this.parseBcchDate(
                item.indexDateString,
              ),
            value:
              Number(item.value),
          }))
          .filter(
            (item) =>
              item.date !== null &&
              Number.isFinite(
                item.value,
              ) &&
              item.value > 0,
          )
          .sort(
            (a, b) =>
              (b.date?.getTime() ?? 0) -
              (a.date?.getTime() ?? 0),
          );

      const latest =
        candidates[0];

      if (!latest?.date) {
        throw new BadGatewayException(
          'Banco Central no devolvió observaciones válidas para la UF',
        );
      }

      const saved =
        await this.runSerializable(
          async (tx) => {
            const indicator =
              await tx.economicIndicator.upsert({
                where: {
                  code_date: {
                    code: UF_CODE,
                    date: latest.date!,
                  },
                },
                create: {
                  code: UF_CODE,
                  date: latest.date!,
                  value: latest.value,
                  source: 'BCCH',
                  fetchedAt:
                    new Date(),
                },
                update: {
                  value: latest.value,
                  source: 'BCCH',
                  fetchedAt:
                    new Date(),
                },
              });

            await tx.auditLog.create({
              data: {
                action: 'REFRESH',
                entityType:
                  'ECONOMIC_INDICATOR',
                entityId: indicator.id,
                entityName: UF_CODE,
                userId:
                  currentUser.sub,
                companyId: null,
                details: this.toInputJsonValue({
                  message:
                    'UF actualizada desde Banco Central de Chile',
                  date:
                    indicator.date.toISOString(),
                  value:
                    Number(indicator.value),
                  series,
                }),
              },
            });

            return indicator;
          },
        );

      return {
        id: saved.id,
        code: saved.code,
        date: saved.date,
        value: Number(saved.value),
        source: saved.source,
        fetchedAt:
          saved.fetchedAt,
      };
    } catch (error) {
      if (
        error instanceof BadGatewayException ||
        error instanceof BadRequestException ||
        error instanceof ConflictException
      ) {
        throw error;
      }

      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        throw new BadGatewayException(
          `Tiempo de espera agotado consultando Banco Central (${timeoutMs} ms)`,
        );
      }

      throw new BadGatewayException(
        error instanceof Error
          ? `No fue posible consultar Banco Central: ${error.message}`
          : 'No fue posible consultar Banco Central',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async setManualUf(
    dto: ManualUfDto,
    currentUser: CurrentUser,
  ) {
    const date =
      this.parseIsoDate(
        dto.date,
      );

    const saved =
      await this.runSerializable(
        async (tx) => {
          const indicator =
            await tx.economicIndicator.upsert({
              where: {
                code_date: {
                  code: UF_CODE,
                  date,
                },
              },
              create: {
                code: UF_CODE,
                date,
                value: dto.value,
                source: 'MANUAL',
                fetchedAt:
                  new Date(),
              },
              update: {
                value: dto.value,
                source: 'MANUAL',
                fetchedAt:
                  new Date(),
              },
            });

          await tx.auditLog.create({
            data: {
              action: 'UPDATE',
              entityType:
                'ECONOMIC_INDICATOR',
              entityId:
                indicator.id,
              entityName: UF_CODE,
              userId:
                currentUser.sub,
              companyId: null,
              details: this.toInputJsonValue({
                message:
                  'UF registrada manualmente',
                date:
                  indicator.date.toISOString(),
                value:
                  Number(indicator.value),
              }),
            },
          });

          return indicator;
        },
      );

    return {
      id: saved.id,
      code: saved.code,
      date: saved.date,
      value: Number(saved.value),
      source: saved.source,
      fetchedAt:
        saved.fetchedAt,
    };
  }

  async createTariff(
    dto: CreatePricingTariffDto,
    currentUser: CurrentUser,
  ) {
    const category =
      dto.category.trim().toUpperCase();
    const requestedName =
      dto.name.trim();
    const unit =
      dto.unit.trim();

    if (
      !category ||
      !requestedName ||
      !unit
    ) {
      throw new BadRequestException(
        'Categoría, nombre y unidad son obligatorios',
      );
    }

    return this.runSerializable(
      async (tx) => {
        let name = requestedName;
        let operatingSystemName:
          string | null = null;
        let softwareId:
          number | null = null;

        if (
          category ===
          'SISTEMA_OPERATIVO'
        ) {
          const operatingSystem =
            await tx.operatingSystem.findFirst({
              where: {
                active: true,
                name: {
                  equals: name,
                  mode: 'insensitive',
                },
              },
              select: {
                name: true,
              },
            });

          if (!operatingSystem) {
            throw new BadRequestException(
              'El sistema operativo debe existir y estar activo en el catálogo de Sistemas Operativos',
            );
          }

          name = operatingSystem.name;
          operatingSystemName =
            operatingSystem.name;

          const duplicate =
            await tx.pricingTariff.findFirst({
              where: {
                category:
                  'SISTEMA_OPERATIVO',
                operatingSystemName: {
                  equals:
                    operatingSystem.name,
                  mode: 'insensitive',
                },
              },
              select: {
                id: true,
              },
            });

          if (duplicate) {
            throw new ConflictException(
              `Ya existe una tarifa asociada al sistema operativo ${operatingSystem.name}`,
            );
          }
        }

        if (
          category === 'SERVICIOS' &&
          dto.valueType === 'PERCENT' &&
          (dto.active ?? true)
        ) {
          await this.assertSingleActivePercentServicesTariff(
            tx,
          );
        }

        if (
          category ===
          'BASE_DATOS'
        ) {
          const software =
            await tx.software.findFirst({
              where: {
                active: true,
                category: 'DATABASE',
                name: {
                  equals: name,
                  mode: 'insensitive',
                },
              },
              select: {
                id: true,
                name: true,
              },
            });

          if (!software) {
            throw new BadRequestException(
              'La base de datos debe existir, estar activa y estar categorizada como Base de datos en Sistemas',
            );
          }

          const duplicate =
            await tx.pricingTariff.findFirst({
              where: {
                category: 'BASE_DATOS',
                softwareId: software.id,
              },
              select: {
                id: true,
              },
            });

          if (duplicate) {
            throw new ConflictException(
              `Ya existe una tarifa asociada a ${software.name}`,
            );
          }

          name = software.name;
          softwareId = software.id;
        }

        const normalizedName =
          name
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') ||
          'TARIFA';

        const normalizedCategory =
          category
            .replace(/[^A-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') ||
          'GENERAL';

        const baseCode =
          `CUSTOM_${normalizedCategory}_${normalizedName}`
            .slice(0, 110);

        let code = baseCode;
        let suffix = 2;

        while (
          await tx.pricingTariff.findUnique({
            where: { code },
            select: { id: true },
          })
        ) {
          code =
            `${baseCode.slice(0, 104)}_${suffix}`;
          suffix += 1;
        }

        const created =
          await tx.pricingTariff.create({
            data: {
              code,
              category,
              name,
              unit,
              value: dto.value,
              valueType: dto.valueType,
              active:
                dto.active ?? true,
              sourceNote: null,
              operatingSystemName,
              softwareId,
            },
          });

        await tx.auditLog.create({
          data: {
            action: 'CREATE',
            entityType:
              'PRICING_TARIFF',
            entityId: created.id,
            entityName: created.name,
            userId:
              currentUser.sub,
            companyId: null,
            details: this.toInputJsonValue({
              message:
                'Tarifa de cotización creada',
              code: created.code,
              category:
                created.category,
              unit: created.unit,
              value:
                Number(created.value),
              valueType:
                created.valueType,
              active:
                created.active,
              operatingSystemName:
                created.operatingSystemName,
              softwareId:
                created.softwareId,
            }),
          },
        });

        return {
          ...created,
          value:
            Number(created.value),
        };
      },
    );
  }

  async updateTariff(
    id: number,
    dto: UpdatePricingTariffDto,
    currentUser: CurrentUser,
  ) {
    if (
      dto.name === undefined &&
      dto.value === undefined &&
      dto.active === undefined &&
      dto.sourceNote === undefined
    ) {
      throw new BadRequestException(
        'No se enviaron cambios para la tarifa',
      );
    }

    return this.runSerializable(
      async (tx) => {
        const current =
          await tx.pricingTariff.findUnique({
            where: {
              id,
            },
          });

        if (!current) {
          throw new NotFoundException(
            'Tarifa no encontrada',
          );
        }

        let name:
          string | undefined;
        let operatingSystemName:
          string | null | undefined;
        let softwareId:
          number | null | undefined;

        if (dto.name !== undefined) {
          const requestedName =
            dto.name.trim();

          if (!requestedName) {
            throw new BadRequestException(
              'El nombre de la tarifa no puede quedar vacío',
            );
          }

          // Si el nombre enviado ya coincide con el nombre canónico actual,
          // no es necesario volver a resolver el catálogo asociado. Esto
          // permite no-op y cambios de otros campos en tarifas inactivas cuyo
          // catálogo también está inactivo, sin relajar la validación de una
          // reactivación ni de un cambio real de nombre.
          if (requestedName === current.name) {
            name = current.name;
          } else if (
            current.category ===
            'SISTEMA_OPERATIVO'
          ) {
            const operatingSystem =
              await tx.operatingSystem.findFirst({
                where: {
                  active: true,
                  name: {
                    equals: requestedName,
                    mode: 'insensitive',
                  },
                },
                select: {
                  name: true,
                },
              });

            if (!operatingSystem) {
              throw new BadRequestException(
                'El sistema operativo debe existir y estar activo en el catálogo de Sistemas Operativos',
              );
            }

            const duplicate =
              await tx.pricingTariff.findFirst({
                where: {
                  id: {
                    not: id,
                  },
                  category:
                    'SISTEMA_OPERATIVO',
                  operatingSystemName: {
                    equals:
                      operatingSystem.name,
                    mode: 'insensitive',
                  },
                },
                select: {
                  id: true,
                },
              });

            if (duplicate) {
              throw new ConflictException(
                `Ya existe una tarifa asociada al sistema operativo ${operatingSystem.name}`,
              );
            }

            name =
              operatingSystem.name;
            operatingSystemName =
              operatingSystem.name;
          } else if (
            current.category ===
            'BASE_DATOS'
          ) {
            const software =
              await tx.software.findFirst({
                where: {
                  active: true,
                  category: 'DATABASE',
                  name: {
                    equals: requestedName,
                    mode: 'insensitive',
                  },
                },
                select: {
                  id: true,
                  name: true,
                },
              });

            if (!software) {
              throw new BadRequestException(
                'La base de datos debe existir, estar activa y estar categorizada como Base de datos en Sistemas',
              );
            }

            const duplicate =
              await tx.pricingTariff.findFirst({
                where: {
                  id: { not: id },
                  category:
                    'BASE_DATOS',
                  softwareId:
                    software.id,
                },
                select: {
                  id: true,
                },
              });

            if (duplicate) {
              throw new ConflictException(
                `Ya existe una tarifa asociada a ${software.name}`,
              );
            }

            name = software.name;
            softwareId = software.id;
          } else {
            name = requestedName;
          }
        }

        const nextActive =
          dto.active ?? current.active;
        const nextOperatingSystemName =
          operatingSystemName === undefined
            ? current.operatingSystemName
            : operatingSystemName;
        const nextSoftwareId =
          softwareId === undefined
            ? current.softwareId
            : softwareId;

        if (
          nextActive &&
          current.category === 'SERVICIOS' &&
          current.valueType === 'PERCENT'
        ) {
          await this.assertSingleActivePercentServicesTariff(
            tx,
            current.id,
          );
        }

        if (
          nextActive &&
          current.category ===
            'SISTEMA_OPERATIVO'
        ) {
          if (!nextOperatingSystemName) {
            throw new ConflictException(
              'La tarifa de sistema operativo no tiene una familia asociada válida',
            );
          }

          const activeOperatingSystem =
            await tx.operatingSystem.findFirst({
              where: {
                active: true,
                name: {
                  equals:
                    nextOperatingSystemName,
                  mode: 'insensitive',
                },
              },
              select: {
                id: true,
              },
            });

          if (!activeOperatingSystem) {
            throw new ConflictException(
              `No se puede activar la tarifa: no existe un sistema operativo activo para ${nextOperatingSystemName}`,
            );
          }
        }

        if (
          nextActive &&
          current.category ===
            'BASE_DATOS'
        ) {
          if (!nextSoftwareId) {
            throw new ConflictException(
              'La tarifa de base de datos no tiene un sistema asociado válido',
            );
          }

          const activeSoftware =
            await tx.software.findFirst({
              where: {
                id: nextSoftwareId,
                active: true,
                category: 'DATABASE',
              },
              select: {
                id: true,
              },
            });

          if (!activeSoftware) {
            throw new ConflictException(
              'No se puede activar la tarifa: la base de datos asociada no está activa o ya no pertenece a la categoría DATABASE',
            );
          }
        }

        const normalizedSourceNote =
          dto.sourceNote === undefined
            ? undefined
            : dto.sourceNote === null
              ? null
              : dto.sourceNote.trim() || null;

        const nextName =
          name ?? current.name;
        const nextValue =
          dto.value ?? Number(current.value);
        const nextSourceNote =
          normalizedSourceNote === undefined
            ? current.sourceNote
            : normalizedSourceNote;

        const hasChanges =
          nextName !== current.name ||
          nextValue !== Number(current.value) ||
          nextActive !== current.active ||
          nextSourceNote !== current.sourceNote ||
          nextOperatingSystemName !==
            current.operatingSystemName ||
          nextSoftwareId !==
            current.softwareId;

        if (!hasChanges) {
          return {
            ...current,
            value:
              Number(current.value),
          };
        }

        const updated =
          await tx.pricingTariff.update({
            where: {
              id,
            },
            data: {
              name,
              value:
                dto.value,
              active:
                dto.active,
              sourceNote:
                normalizedSourceNote,
              operatingSystemName,
              softwareId,
            },
          });

        const changedFields: string[] = [];

        if (updated.name !== current.name) {
          changedFields.push('name');
        }
        if (
          Number(updated.value) !==
          Number(current.value)
        ) {
          changedFields.push('value');
        }
        if (
          updated.active !==
          current.active
        ) {
          changedFields.push('active');
        }
        if (
          updated.sourceNote !==
          current.sourceNote
        ) {
          changedFields.push('sourceNote');
        }
        if (
          updated.operatingSystemName !==
          current.operatingSystemName
        ) {
          changedFields.push(
            'operatingSystemName',
          );
        }
        if (
          updated.softwareId !==
          current.softwareId
        ) {
          changedFields.push('softwareId');
        }

        const onlyActiveChanged =
          changedFields.length === 1 &&
          changedFields[0] === 'active';

        const action =
          onlyActiveChanged
            ? updated.active
              ? 'ACTIVATE'
              : 'DEACTIVATE'
            : 'UPDATE';

        await tx.auditLog.create({
          data: {
            action,
            entityType:
              'PRICING_TARIFF',
            entityId:
              updated.id,
            entityName:
              updated.name,
            userId:
              currentUser.sub,
            companyId: null,
            details: this.toInputJsonValue({
              message:
                'Tarifa de cotización actualizada',
              code:
                updated.code,
              fields:
                changedFields,
              before: {
                name:
                  current.name,
                value:
                  Number(current.value),
                active:
                  current.active,
                sourceNote:
                  current.sourceNote,
                operatingSystemName:
                  current.operatingSystemName,
                softwareId:
                  current.softwareId,
              },
              after: {
                name:
                  updated.name,
                value:
                  Number(updated.value),
                active:
                  updated.active,
                sourceNote:
                  updated.sourceNote,
                operatingSystemName:
                  updated.operatingSystemName,
                softwareId:
                  updated.softwareId,
              },
            }),
          },
        });

        return {
          ...updated,
          value:
            Number(updated.value),
        };
      },
    );
  }


  async deleteTariff(
    id: number,
    currentUser: CurrentUser,
  ) {
    return this.runSerializable(
      async (tx) => {
        const current =
          await tx.pricingTariff.findUnique({
            where: {
              id,
            },
          });

        if (!current) {
          throw new NotFoundException(
            'Tarifa no encontrada',
          );
        }

        if (
          PROTECTED_PRICING_TARIFF_CODES.has(
            current.code,
          )
        ) {
          throw new ConflictException(
            'Esta tarifa es estructural para el motor de valorización y no se puede eliminar. Puedes modificar su valor o desactivarla.',
          );
        }

        await tx.pricingTariff.delete({
          where: {
            id,
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'DELETE',
            entityType:
              'PRICING_TARIFF',
            entityId:
              current.id,
            entityName:
              current.name,
            userId:
              currentUser.sub,
            companyId: null,
            details: this.toInputJsonValue({
              message:
                'Tarifa de cotización eliminada',
              before: {
                code:
                  current.code,
                category:
                  current.category,
                name:
                  current.name,
                unit:
                  current.unit,
                value:
                  Number(current.value),
                valueType:
                  current.valueType,
                active:
                  current.active,
                sourceNote:
                  current.sourceNote,
                operatingSystemName:
                  current.operatingSystemName,
                softwareId:
                  current.softwareId,
                createdAt:
                  current.createdAt.toISOString(),
                updatedAt:
                  current.updatedAt.toISOString(),
              },
            }),
          },
        });

        return {
          id: current.id,
          code: current.code,
          name: current.name,
          deleted: true,
        };
      },
    );
  }

  async getServerValuations(
    currentUser: CurrentUser,
    companyIdValue?: string,
    environmentValue?: string,
  ) {
    const companyId =
      companyIdValue
        ? Number(companyIdValue)
        : undefined;

    if (
      companyId !== undefined &&
      (!Number.isInteger(companyId) ||
        companyId <= 0)
    ) {
      throw new BadRequestException(
        'Empresa inválida',
      );
    }

    const environment =
      environmentValue
        ?.trim()
        .toUpperCase();

    if (
      environment &&
      !['PRD', 'QAS', 'DEV'].includes(
        environment,
      )
    ) {
      throw new BadRequestException(
        'Ambiente inválido',
      );
    }

    const companyWhere =
      await buildScopedServerCompanyWhere(
        this.prisma,
        currentUser,
        companyId,
      );

    const accessibleCompanies =
      await getAccessibleCompanies(
        this.prisma,
        currentUser,
      );

    const [
      servers,
      rawTariffs,
      uf,
    ] = await Promise.all([
      this.prisma.server.findMany({
        where: {
          active: true,
          ...companyWhere,
          ...(environment
            ? { environment }
            : {}),
        },
        select: {
          id: true,
          hostname: true,
          environment: true,
          cpuCores: true,
          ramGb: true,
          diskGb: true,
          servicesOnitec: true,
          companyId: true,
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
            },
          },
          software: {
            select: {
              softwareId: true,
              version: true,
              software: {
                select: {
                  id: true,
                  name: true,
                  category: true,
                },
              },
            },
          },
        },
        orderBy: [
          {
            company: {
              name: 'asc',
            },
          },
          { hostname: 'asc' },
        ],
      }),
      this.prisma.pricingTariff.findMany({
        where: { active: true },
        orderBy: { id: 'asc' },
      }),
      this.getLatestUf(),
    ]);

    const tariffs: ValuationTariff[] =
      rawTariffs.map((tariff) => ({
        id: tariff.id,
        code: tariff.code,
        category: tariff.category,
        name: tariff.name,
        unit: tariff.unit,
        value: Number(tariff.value),
        valueType: tariff.valueType,
        operatingSystemName:
          tariff.operatingSystemName,
        softwareId: tariff.softwareId,
      }));

    const items =
      (servers as ValuationServer[]).map(
        (server) =>
          this.calculateServerValuation(
            server,
            tariffs,
            uf?.value ?? null,
          ),
      );

    const totalUf =
      items.reduce(
        (sum, item) =>
          sum + item.totalUf,
        0,
      );

    const fullyValued =
      items.filter(
        (item) =>
          item.status === 'COMPLETE',
      ).length;

    const byCompanyMap =
      new Map<
        number,
        {
          id: number;
          name: string;
          servers: number;
          complete: number;
          partial: number;
          totalUf: number;
        }
      >();

    for (const item of items) {
      if (!item.company) {
        continue;
      }

      const current =
        byCompanyMap.get(
          item.company.id,
        ) ?? {
          id: item.company.id,
          name: item.company.name,
          servers: 0,
          complete: 0,
          partial: 0,
          totalUf: 0,
        };

      current.servers += 1;
      current.totalUf +=
        item.totalUf;

      if (
        item.status === 'COMPLETE'
      ) {
        current.complete += 1;
      } else {
        current.partial += 1;
      }

      byCompanyMap.set(
        item.company.id,
        current,
      );
    }

    return {
      selectedCompanyId:
        companyId ?? null,
      selectedEnvironment:
        environment ?? null,
      checkedAt:
        new Date(),
      uf,
      totals: {
        servers: items.length,
        fullyValued,
        partial:
          items.length -
          fullyValued,
        totalUf:
          this.roundPricingValue(
            totalUf,
          ),
        totalClp:
          uf
            ? Math.round(
                totalUf *
                  uf.value,
              )
            : null,
      },
      availableCompanies:
        accessibleCompanies.map(
          (company) => ({
            id: company.id,
            name: company.name,
          }),
        ),
      byCompany:
        Array.from(
          byCompanyMap.values(),
        )
          .map((item) => ({
            ...item,
            totalUf:
              this.roundPricingValue(
                item.totalUf,
              ),
            totalClp:
              uf
                ? Math.round(
                    item.totalUf *
                      uf.value,
                  )
                : null,
          }))
          .sort((a, b) =>
            b.totalUf - a.totalUf,
          ),
      items,
    };
  }

  async getServerValuation(
    currentUser: CurrentUser,
    serverId: number,
  ) {
    const companyWhere =
      await buildScopedServerCompanyWhere(
        this.prisma,
        currentUser,
      );

    const server =
      await this.prisma.server.findFirst({
        where: {
          id: serverId,
          active: true,
          ...companyWhere,
        },
        select: {
          id: true,
          hostname: true,
          environment: true,
          cpuCores: true,
          ramGb: true,
          diskGb: true,
          servicesOnitec: true,
          companyId: true,
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
            },
          },
          software: {
            select: {
              softwareId: true,
              version: true,
              software: {
                select: {
                  id: true,
                  name: true,
                  category: true,
                },
              },
            },
          },
        },
      });

    if (!server) {
      throw new NotFoundException(
        'Servidor no encontrado',
      );
    }

    const [rawTariffs, uf] =
      await Promise.all([
        this.prisma.pricingTariff.findMany({
          where: { active: true },
          orderBy: { id: 'asc' },
        }),
        this.getLatestUf(),
      ]);

    const tariffs: ValuationTariff[] =
      rawTariffs.map((tariff) => ({
        id: tariff.id,
        code: tariff.code,
        category: tariff.category,
        name: tariff.name,
        unit: tariff.unit,
        value: Number(tariff.value),
        valueType: tariff.valueType,
        operatingSystemName:
          tariff.operatingSystemName,
        softwareId: tariff.softwareId,
      }));

    return this.calculateServerValuation(
      server as ValuationServer,
      tariffs,
      uf?.value ?? null,
    );
  }

  private calculateServerValuation(
    server: ValuationServer,
    tariffs: ValuationTariff[],
    ufValue: number | null,
  ) {
    const missing: string[] = [];
    const rows: Array<{
      key: string;
      resource: string;
      detail: string;
      quantity: number | null;
      unitValueUf: number | null;
      valueUf: number;
      tariffId: number | null;
    }> = [];

    const byCode =
      new Map(
        tariffs.map((tariff) => [
          tariff.code,
          tariff,
        ]),
      );

    const osTariff =
      server.operatingSystem
        ? tariffs.find(
            (tariff) =>
              tariff.category ===
                'SISTEMA_OPERATIVO' &&
              tariff.operatingSystemName
                ?.toLowerCase() ===
                server.operatingSystem?.name
                  .toLowerCase(),
          )
        : undefined;

    if (server.operatingSystem) {
      if (osTariff) {
        rows.push({
          key: 'operatingSystem',
          resource: 'S.O.',
          detail:
            server.operatingSystem.name,
          quantity: 1,
          unitValueUf:
            osTariff.value,
          valueUf:
            osTariff.value,
          tariffId:
            osTariff.id,
        });
      } else {
        missing.push(
          `Sin tarifa de SO para ${server.operatingSystem.name}`,
        );
      }
    } else {
      missing.push(
        'Servidor sin sistema operativo',
      );
    }

    const resourceDefinitions = [
      {
        key: 'cpu',
        code: 'CPU_VCPU',
        resource: 'CPU',
        quantity: server.cpuCores,
        unit: 'vCPU',
      },
      {
        key: 'ram',
        code: 'RAM_GB',
        resource: 'RAM',
        quantity: server.ramGb,
        unit: 'GB',
      },
      {
        key: 'disk',
        code: 'DISK_GB',
        resource: 'Disco',
        quantity: server.diskGb,
        unit: 'GB',
      },
    ];

    for (
      const definition of
        resourceDefinitions
    ) {
      if (
        !definition.quantity ||
        definition.quantity <= 0
      ) {
        missing.push(
          `${definition.resource} sin información`,
        );
        continue;
      }

      const tariff =
        byCode.get(
          definition.code,
        );

      if (!tariff) {
        missing.push(
          `${definition.resource} sin tarifa activa`,
        );
        continue;
      }

      rows.push({
        key: definition.key,
        resource:
          definition.resource,
        detail:
          `${definition.quantity} ${definition.unit}`,
        quantity:
          definition.quantity,
        unitValueUf:
          tariff.value,
        valueUf:
          definition.quantity *
          tariff.value,
        tariffId:
          tariff.id,
      });
    }

    const databaseSoftware =
      server.software.filter(
        (item) =>
          item.software.category ===
          'DATABASE',
      );

    const seenDatabaseIds =
      new Set<number>();

    for (const installed of databaseSoftware) {
      if (
        seenDatabaseIds.has(
          installed.softwareId,
        )
      ) {
        continue;
      }

      seenDatabaseIds.add(
        installed.softwareId,
      );

      const tariff =
        tariffs.find(
          (item) =>
            item.category ===
              'BASE_DATOS' &&
            item.softwareId ===
              installed.softwareId,
        );

      if (!tariff) {
        missing.push(
          `Sin tarifa de BD para ${installed.software.name}`,
        );
        continue;
      }

      rows.push({
        key:
          `database-${installed.softwareId}`,
        resource: 'BD',
        detail:
          installed.software.name,
        quantity: 1,
        unitValueUf:
          tariff.value,
        valueUf:
          tariff.value,
        tariffId:
          tariff.id,
      });
    }

    const subtotal =
      rows.reduce(
        (sum, row) =>
          sum + row.valueUf,
        0,
      );

    const servicesTariff =
      tariffs.find(
        (tariff) =>
          tariff.category ===
            'SERVICIOS' &&
          tariff.valueType ===
            'PERCENT',
      );

    let totalUf = subtotal;

    if (server.servicesOnitec && servicesTariff) {
      const servicesValue =
        subtotal *
        (servicesTariff.value /
          100);

      rows.push({
        key: 'services',
        resource:
          servicesTariff.name,
        detail:
          `${servicesTariff.value}% subtotal`,
        quantity: null,
        unitValueUf: null,
        valueUf:
          servicesValue,
        tariffId:
          servicesTariff.id,
      });

      totalUf +=
        servicesValue;
    } else if (server.servicesOnitec) {
      missing.push(
        'Servicios Onitec sin tarifa porcentual activa',
      );
    }

    const roundedTotal =
      this.roundPricingValue(
        totalUf,
      );

    return {
      id: server.id,
      hostname:
        server.hostname,
      environment:
        server.environment,
      servicesOnitec:
        server.servicesOnitec,
      company:
        server.company,
      operatingSystem:
        server.operatingSystem,
      databases:
        databaseSoftware.map(
          (item) => ({
            id: item.software.id,
            name: item.software.name,
            version: item.version,
          }),
        ),
      resources: {
        cpuCores:
          server.cpuCores,
        ramGb:
          server.ramGb,
        diskGb:
          server.diskGb,
      },
      status:
        missing.length === 0
          ? 'COMPLETE'
          : 'PARTIAL',
      missing,
      rows:
        rows.map((row) => ({
          ...row,
          unitValueUf:
            row.unitValueUf === null
              ? null
              : this.roundPricingValue(
                  row.unitValueUf,
                ),
          valueUf:
            this.roundPricingValue(
              row.valueUf,
            ),
        })),
      subtotalUf:
        this.roundPricingValue(
          subtotal,
        ),
      totalUf:
        roundedTotal,
      totalClp:
        ufValue === null
          ? null
          : Math.round(
              roundedTotal *
                ufValue,
            ),
    };
  }

  private async assertSingleActivePercentServicesTariff(
    tx: Prisma.TransactionClient,
    excludeId?: number,
  ) {
    const existing =
      await tx.pricingTariff.findFirst({
        where: {
          category: 'SERVICIOS',
          valueType: 'PERCENT',
          active: true,
          ...(excludeId
            ? {
                id: {
                  not: excludeId,
                },
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
        },
      });

    if (existing) {
      throw new ConflictException(
        `Ya existe una tarifa porcentual de servicios activa: ${existing.name}. Desactívala antes de activar otra.`,
      );
    }
  }

  private roundPricingValue(
    value: number,
  ) {
    return Math.round(
      (value + Number.EPSILON) *
        1_000_000,
    ) / 1_000_000;
  }

  private getPositiveIntegerEnv(
    name: string,
    fallback: number,
  ) {
    const value =
      Number(
        process.env[name],
      );

    return Number.isInteger(value) &&
      value > 0
      ? value
      : fallback;
  }

  private getChileDateString(
    date: Date,
  ) {
    const parts =
      new Intl.DateTimeFormat(
        'en-CA',
        {
          timeZone:
            'America/Santiago',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        },
      ).formatToParts(
        date,
      );

    const values =
      new Map(
        parts.map(
          (part) => [
            part.type,
            part.value,
          ],
        ),
      );

    return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
  }

  private parseBcchDate(
    value: string | undefined,
  ): Date | null {
    if (!value) {
      return null;
    }

    const match =
      value.match(
        /^(\d{2})-(\d{2})-(\d{4})$/,
      );

    if (!match) {
      return null;
    }

    const day =
      Number(match[1]);
    const month =
      Number(match[2]);
    const year =
      Number(match[3]);

    const date =
      new Date(
        Date.UTC(
          year,
          month - 1,
          day,
          12,
        ),
      );

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }

    return date;
  }

  private parseIsoDate(
    value: string,
  ) {
    const match =
      value.match(
        /^(\d{4})-(\d{2})-(\d{2})$/,
      );

    if (!match) {
      throw new BadRequestException(
        'Fecha UF inválida',
      );
    }

    const year =
      Number(match[1]);
    const month =
      Number(match[2]);
    const day =
      Number(match[3]);

    const date =
      new Date(
        Date.UTC(
          year,
          month - 1,
          day,
          12,
        ),
      );

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new BadRequestException(
        'Fecha UF inválida',
      );
    }

    return date;
  }

  private async runSerializable<T>(
    operation: (
      tx: Prisma.TransactionClient,
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(
        operation,
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new ConflictException(
          'La operación entró en conflicto con otro cambio concurrente. Intenta nuevamente.',
        );
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya existe un registro con los mismos datos únicos',
        );
      }

      throw error;
    }
  }

  private toInputJsonValue(
    value: unknown,
  ): Prisma.InputJsonValue {
    return JSON.parse(
      JSON.stringify(value),
    ) as Prisma.InputJsonValue;
  }
}
