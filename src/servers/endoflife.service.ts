import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

type SupportStatus =
  | 'SUPPORTED'
  | 'EOL_SOON'
  | 'EOL'
  | 'UNKNOWN';

export type EndOfLifeMappingEntityType =
  | 'SOFTWARE'
  | 'OPERATING_SYSTEM';

export type EndOfLifeResolutionSource =
  | 'CONFIGURED'
  | 'LEGACY_ALIAS'
  | 'CATALOG_EXACT'
  | 'NONE';

interface CurrentUser {
  sub: number;
  username: string;
  companyId: number | null;
}

export interface EndOfLifeProductSummary {
  name: string;
  label: string;
  aliases: string[];
  category: string | null;
  tags: string[];
}

export interface EndOfLifeRelease {
  name: string;
  label?: string | null;
  releaseDate?: string | null;
  isLts?: boolean;
  isEol?: boolean;
  eolFrom?: string | null;
  isMaintained?: boolean;
  latest?: {
    name?: string | null;
    date?: string | null;
  } | null;
}

interface EndOfLifeApiResponse {
  generated_at?: string;
  result?: {
    name?: string;
    aliases?: string[];
    label?: string;
    category?: string;
    tags?: string[];
    releases?: EndOfLifeRelease[];
  };
}

interface EndOfLifeProductsApiResponse {
  generated_at?: string;
  result?: Array<{
    name?: string;
    aliases?: string[];
    label?: string;
    category?: string;
    tags?: string[];
  }>;
}

interface CachedProduct {
  expiresAt: number;
  value: EndOfLifeApiResponse | null;
}

interface CachedCatalog {
  expiresAt: number;
  checkedAt: string;
  status: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE';
  products: EndOfLifeProductSummary[];
}

export interface ResolvedProduct {
  productKey: string | null;
  source: EndOfLifeResolutionSource;
  product: EndOfLifeProductSummary | null;
}

const PRODUCT_ALIASES: Record<string, string> = {
  postgresql: 'postgresql',
  postgres: 'postgresql',
  node: 'nodejs',
  'node.js': 'nodejs',
  nodejs: 'nodejs',
  kubernetes: 'kubernetes',
  k8s: 'kubernetes',
  containerd: 'containerd',
  docker: 'docker-engine',
  'docker engine': 'docker-engine',
  nginx: 'nginx',
  redis: 'redis',
};

const DEFAULT_API_BASE_URL =
  'https://endoflife.date/api/v1';

const DEFAULT_CACHE_TTL_SECONDS =
  6 * 60 * 60;

const DEFAULT_PRODUCTS_CACHE_TTL_SECONDS =
  24 * 60 * 60;

const DEFAULT_REQUEST_TIMEOUT_MS =
  5000;

const DEFAULT_EOL_SOON_DAYS =
  180;

const UNAVAILABLE_CACHE_TTL_MS =
  5 * 60 * 1000;

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
) {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) &&
    parsed > 0
    ? parsed
    : fallback;
}

function readApiBaseUrl(
  value: string | undefined,
) {
  const configured =
    value?.trim() ||
    DEFAULT_API_BASE_URL;

  return configured.replace(
    /\/+$/,
    '',
  );
}

export function normalizeEndOfLifeName(
  value: string,
) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeProductKey(
  value: string | null | undefined,
) {
  const normalized =
    value?.trim().toLocaleLowerCase() ?? '';

  return normalized || null;
}

export function resolveExactCatalogProduct(
  localName: string,
  products: EndOfLifeProductSummary[],
) {
  const normalizedLocal =
    normalizeEndOfLifeName(localName);

  if (!normalizedLocal) {
    return null;
  }

  return (
    products.find((product) => {
      const candidates = [
        product.name,
        product.label,
        ...product.aliases,
      ];

      return candidates.some(
        (candidate) =>
          normalizeEndOfLifeName(candidate) ===
          normalizedLocal,
      );
    }) ?? null
  );
}

export function suggestCatalogProduct(
  localName: string,
  products: EndOfLifeProductSummary[],
) {
  const normalizedLocal =
    normalizeEndOfLifeName(localName);

  if (!normalizedLocal) {
    return null;
  }

  const localTokens =
    new Set(
      normalizedLocal
        .split(' ')
        .filter(Boolean),
    );

  let best:
    | {
        product: EndOfLifeProductSummary;
        score: number;
      }
    | null = null;

  for (const product of products) {
    const candidates = [
      product.name,
      product.label,
      ...product.aliases,
    ];

    let productScore = 0;

    for (const candidate of candidates) {
      const normalizedCandidate =
        normalizeEndOfLifeName(candidate);

      if (!normalizedCandidate) {
        continue;
      }

      if (
        normalizedCandidate.includes(
          normalizedLocal,
        ) ||
        normalizedLocal.includes(
          normalizedCandidate,
        )
      ) {
        productScore = Math.max(
          productScore,
          80 -
            Math.min(
              30,
              Math.abs(
                normalizedCandidate.length -
                  normalizedLocal.length,
              ),
            ),
        );
      }

      const candidateTokens =
        new Set(
          normalizedCandidate
            .split(' ')
            .filter(Boolean),
        );

      const overlap =
        [...localTokens].filter(
          (token) =>
            candidateTokens.has(token),
        ).length;

      if (overlap > 0) {
        const ratio =
          overlap /
          Math.max(
            localTokens.size,
            candidateTokens.size,
          );

        productScore = Math.max(
          productScore,
          Math.round(
            45 +
              ratio * 25,
          ),
        );
      }
    }

    if (
      productScore >= 55 &&
      (
        !best ||
        productScore > best.score
      )
    ) {
      best = {
        product,
        score: productScore,
      };
    }
  }

  return best?.product ?? null;
}

export function resolveReleaseCycle(
  installedVersion: string,
  releases: EndOfLifeRelease[],
) {
  const numeric =
    installedVersion
      .trim()
      .replace(/^v/i, '')
      .match(/\d+(?:\.\d+)*/)?.[0];

  if (!numeric) {
    return null;
  }

  const parts =
    numeric.split('.');

  const candidates: string[] = [];

  for (
    let length = parts.length;
    length >= 1;
    length -= 1
  ) {
    const candidate =
      parts
        .slice(0, length)
        .join('.');

    if (
      candidate &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  }

  for (const candidate of candidates) {
    const release =
      releases.find(
        (item) =>
          item.name === candidate ||
          item.label === candidate,
      );

    if (release) {
      return release;
    }
  }

  return null;
}

@Injectable()
export class EndOfLifeService {
  private readonly cache =
    new Map<string, CachedProduct>();

  private catalogCache:
    CachedCatalog | null = null;

  private readonly apiBaseUrl =
    readApiBaseUrl(
      process.env
        .ENDOFLIFE_API_BASE_URL,
    );

  private readonly cacheTtlMs =
    readPositiveInteger(
      process.env
        .ENDOFLIFE_CACHE_TTL_SECONDS,
      DEFAULT_CACHE_TTL_SECONDS,
    ) * 1000;

  private readonly productsCacheTtlMs =
    readPositiveInteger(
      process.env
        .ENDOFLIFE_PRODUCTS_CACHE_TTL_SECONDS,
      DEFAULT_PRODUCTS_CACHE_TTL_SECONDS,
    ) * 1000;

  private readonly requestTimeoutMs =
    readPositiveInteger(
      process.env
        .ENDOFLIFE_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

  private readonly eolSoonDays =
    readPositiveInteger(
      process.env
        .ENDOFLIFE_EOL_SOON_DAYS,
      DEFAULT_EOL_SOON_DAYS,
    );

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  getEolSoonDays() {
    return this.eolSoonDays;
  }

  async getCatalogResponse(
    forceRefresh = false,
  ) {
    const catalog =
      await this.getProductsCatalog(
        forceRefresh,
      );

    return {
      provider:
        'endoflife.date' as const,
      status:
        catalog.status,
      checkedAt:
        catalog.checkedAt,
      cacheTtlSeconds:
        Math.floor(
          this.productsCacheTtlMs /
            1000,
        ),
      products:
        catalog.products,
    };
  }

  async resolveProductReference(
    localName: string,
  ): Promise<ResolvedProduct> {
    const normalized =
      normalizeEndOfLifeName(localName);

    if (!normalized) {
      return {
        productKey: null,
        source: 'NONE',
        product: null,
      };
    }

    const legacyProductKey =
      PRODUCT_ALIASES[
        localName
          .trim()
          .toLocaleLowerCase()
      ] ??
      PRODUCT_ALIASES[normalized] ??
      null;

    /*
     * Conserva el comportamiento histórico sin forzar una llamada
     * adicional al catálogo. El detalle del producto se resolverá
     * posteriormente con /products/{key}.
     */
    if (legacyProductKey) {
      return {
        productKey:
          legacyProductKey,
        source:
          'LEGACY_ALIAS',
        product:
          this.catalogCache?.products.find(
            (product) =>
              product.name ===
              legacyProductKey,
          ) ?? null,
      };
    }

    const catalog =
      await this.getProductsCatalog();

    const exact =
      resolveExactCatalogProduct(
        localName,
        catalog.products,
      );

    if (exact) {
      return {
        productKey:
          exact.name,
        source:
          'CATALOG_EXACT',
        product:
          exact,
      };
    }

    return {
      productKey: null,
      source: 'NONE',
      product: null,
    };
  }

  async getMappings() {
    const [
      software,
      operatingSystems,
      catalog,
    ] = await Promise.all([
      this.prisma.software.findMany({
        select: {
          id: true,
          name: true,
          category: true,
          active: true,
          eolProductKey: true,
        },
        orderBy: [
          {
            category: 'asc',
          },
          {
            name: 'asc',
          },
        ],
      }),
      this.prisma.operatingSystem.findMany({
        select: {
          id: true,
          name: true,
          version: true,
          active: true,
          eolProductKey: true,
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
      this.getProductsCatalog(),
    ]);

    const productByKey =
      new Map(
        catalog.products.map(
          (product) => [
            product.name,
            product,
          ],
        ),
      );

    const buildResolution = (
      name: string,
      configuredKey:
        | string
        | null,
    ) => {
      const configured =
        normalizeProductKey(
          configuredKey,
        );

      if (configured) {
        return {
          resolvedProductKey:
            configured,
          resolutionSource:
            'CONFIGURED' as const,
          product:
            productByKey.get(
              configured,
            ) ?? null,
          suggestion: null,
        };
      }

      const legacyProductKey =
        PRODUCT_ALIASES[
          name
            .trim()
            .toLocaleLowerCase()
        ] ??
        PRODUCT_ALIASES[
          normalizeEndOfLifeName(
            name,
          )
        ] ??
        null;

      if (legacyProductKey) {
        return {
          resolvedProductKey:
            legacyProductKey,
          resolutionSource:
            'LEGACY_ALIAS' as const,
          product:
            productByKey.get(
              legacyProductKey,
            ) ?? null,
          suggestion: null,
        };
      }

      const exact =
        resolveExactCatalogProduct(
          name,
          catalog.products,
        );

      if (exact) {
        return {
          resolvedProductKey:
            exact.name,
          resolutionSource:
            'CATALOG_EXACT' as const,
          product: exact,
          suggestion: null,
        };
      }

      return {
        resolvedProductKey: null,
        resolutionSource:
          'NONE' as const,
        product: null,
        suggestion:
          suggestCatalogProduct(
            name,
            catalog.products,
          ),
      };
    };

    return {
      provider:
        'endoflife.date' as const,
      catalogStatus:
        catalog.status,
      checkedAt:
        catalog.checkedAt,
      software:
        software.map((item) => ({
          entityType:
            'SOFTWARE' as const,
          id: item.id,
          name: item.name,
          version: null,
          category:
            item.category,
          active:
            item.active,
          configuredProductKey:
            item.eolProductKey,
          ...buildResolution(
            item.name,
            item.eolProductKey,
          ),
        })),
      operatingSystems:
        operatingSystems.map(
          (item) => ({
            entityType:
              'OPERATING_SYSTEM' as const,
            id: item.id,
            name: item.name,
            version:
              item.version,
            category: 'OS',
            active:
              item.active,
            configuredProductKey:
              item.eolProductKey,
            ...buildResolution(
              item.name,
              item.eolProductKey,
            ),
          }),
        ),
    };
  }

  async updateMapping(
    entityType:
      EndOfLifeMappingEntityType,
    id: number,
    productKey:
      | string
      | null
      | undefined,
    currentUser: CurrentUser,
  ) {
    const normalizedProductKey =
      normalizeProductKey(
        productKey,
      );

    if (normalizedProductKey) {
      if (
        !/^[a-z0-9][a-z0-9._-]*$/.test(
          normalizedProductKey,
        )
      ) {
        throw new BadRequestException(
          'El identificador EOL contiene caracteres no válidos',
        );
      }

      const catalog =
        await this.getProductsCatalog();

      if (
        catalog.status ===
          'UNAVAILABLE' ||
        catalog.products.length === 0
      ) {
        throw new ServiceUnavailableException(
          'No fue posible validar el producto con endoflife.date. Intenta nuevamente.',
        );
      }

      const exists =
        catalog.products.some(
          (product) =>
            product.name ===
            normalizedProductKey,
        );

      if (!exists) {
        throw new BadRequestException(
          'El producto seleccionado no existe en el catálogo actual de endoflife.date',
        );
      }
    }

    await this.prisma.$transaction(
      async (tx) => {
        if (
          entityType ===
          'SOFTWARE'
        ) {
          const current =
            await tx.software.findUnique({
              where: {
                id,
              },
              select: {
                id: true,
                name: true,
                eolProductKey: true,
              },
            });

          if (!current) {
            throw new NotFoundException(
              'Sistema no encontrado',
            );
          }

          const before =
            normalizeProductKey(
              current.eolProductKey,
            );

          if (
            before ===
            normalizedProductKey
          ) {
            return;
          }

          const updated =
            await tx.software.update({
              where: {
                id,
              },
              data: {
                eolProductKey:
                  normalizedProductKey,
                updatedById:
                  currentUser.sub,
              },
              select: {
                id: true,
                name: true,
                eolProductKey: true,
              },
            });

          await tx.auditLog.create({
            data: {
              action:
                'UPDATE_EOL_MAPPING',
              entityType:
                'SOFTWARE',
              entityId:
                updated.id,
              entityName:
                updated.name,
              userId:
                currentUser.sub,
              companyId: null,
              details:
                this.toInputJsonValue({
                  message:
                    normalizedProductKey
                      ? 'Asociación endoflife.date actualizada'
                      : 'Asociación endoflife.date eliminada',
                  field:
                    'eolProductKey',
                  before,
                  after:
                    normalizedProductKey,
                }),
            },
          });

          return;
        }

        const current =
          await tx.operatingSystem.findUnique({
            where: {
              id,
            },
            select: {
              id: true,
              name: true,
              version: true,
              eolProductKey: true,
            },
          });

        if (!current) {
          throw new NotFoundException(
            'Sistema operativo no encontrado',
          );
        }

        const before =
          normalizeProductKey(
            current.eolProductKey,
          );

        if (
          before ===
          normalizedProductKey
        ) {
          return;
        }

        const updated =
          await tx.operatingSystem.update({
            where: {
              id,
            },
            data: {
              eolProductKey:
                normalizedProductKey,
              updatedById:
                currentUser.sub,
            },
            select: {
              id: true,
              name: true,
              version: true,
              eolProductKey: true,
            },
          });

        await tx.auditLog.create({
          data: {
            action:
              'UPDATE_EOL_MAPPING',
            entityType:
              'OPERATING_SYSTEM',
            entityId:
              updated.id,
            entityName:
              `${updated.name} ${updated.version}`,
            userId:
              currentUser.sub,
            companyId: null,
            details:
              this.toInputJsonValue({
                message:
                  normalizedProductKey
                    ? 'Asociación endoflife.date actualizada'
                    : 'Asociación endoflife.date eliminada',
                field:
                  'eolProductKey',
                before,
                after:
                  normalizedProductKey,
              }),
          },
        });
      },
    );

    return this.getMappings();
  }

  async analyzeSoftware(
    softwareName: string,
    installedVersions: string[],
  ) {
    const product =
      await this.resolveSoftwareProductKey(
        softwareName,
      );

    return this.analyzeProductVersions(
      product,
      installedVersions,
    );
  }

  async analyzeOperatingSystem(
    operatingSystemName: string,
    installedVersions: string[],
    configuredProductKey?:
      | string
      | null,
  ) {
    const configured =
      normalizeProductKey(
        configuredProductKey,
      );

    const product =
      configured ??
      (
        await this.resolveProductReference(
          operatingSystemName,
        )
      ).productKey;

    return this.analyzeProductVersions(
      product,
      installedVersions,
    );
  }

  private async analyzeProductVersions(
    product: string | null,
    installedVersions: string[],
  ) {
    if (!product) {
      return {
        provider:
          'endoflife.date',
        product: null,
        status:
          'NOT_CONFIGURED' as const,
        checkedAt:
          new Date().toISOString(),
        recommendation: null,
        versions:
          installedVersions.map(
            (version) => ({
              installedVersion:
                version,
              cycle: null,
              status:
                'UNKNOWN' as SupportStatus,
              eolDate: null,
              daysToEol: null,
              latestInCycle: null,
              isLts: false,
            }),
          ),
      };
    }

    const apiData =
      await this.getProduct(
        product,
      );

    if (
      !apiData?.result?.releases
    ) {
      return {
        provider:
          'endoflife.date',
        product,
        status:
          'UNAVAILABLE' as const,
        checkedAt:
          new Date().toISOString(),
        recommendation: null,
        versions:
          installedVersions.map(
            (version) => ({
              installedVersion:
                version,
              cycle: null,
              status:
                'UNKNOWN' as SupportStatus,
              eolDate: null,
              daysToEol: null,
              latestInCycle: null,
              isLts: false,
            }),
          ),
      };
    }

    const releases =
      apiData.result.releases;

    const versions =
      installedVersions.map(
        (version) =>
          this.analyzeVersion(
            version,
            releases,
          ),
      );

    return {
      provider:
        'endoflife.date',
      product,
      status:
        'AVAILABLE' as const,
      checkedAt:
        new Date().toISOString(),
      recommendation:
        this.buildRecommendation(
          releases,
        ),
      versions,
    };
  }

  private async resolveSoftwareProductKey(
    softwareName: string,
  ) {
    const software =
      await this.prisma.software.findFirst({
        where: {
          name: {
            equals:
              softwareName,
            mode: 'insensitive',
          },
        },
        select: {
          eolProductKey: true,
        },
      });

    const configured =
      normalizeProductKey(
        software?.eolProductKey,
      );

    if (configured) {
      return configured;
    }

    const resolved =
      await this.resolveProductReference(
        softwareName,
      );

    return resolved.productKey;
  }

  private async getProductsCatalog(
    forceRefresh = false,
  ): Promise<CachedCatalog> {
    const now = Date.now();

    if (
      !forceRefresh &&
      this.catalogCache &&
      this.catalogCache.expiresAt >
        now
    ) {
      return this.catalogCache;
    }

    const stale =
      this.catalogCache;

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        this.requestTimeoutMs,
      );

    try {
      const response =
        await fetch(
          `${this.apiBaseUrl}/products`,
          {
            headers: {
              Accept:
                'application/json',
              'User-Agent':
                'InfraStock/1.0',
            },
            signal:
              controller.signal,
          },
        );

      if (!response.ok) {
        throw new Error(
          `endoflife.date respondió HTTP ${response.status}`,
        );
      }

      const apiData =
        await response.json() as
          EndOfLifeProductsApiResponse;

      const products =
        (apiData.result ?? [])
          .filter(
            (item) =>
              typeof item.name ===
                'string' &&
              item.name.trim().length >
                0,
          )
          .map(
            (item) => ({
              name:
                item.name!.trim(),
              label:
                item.label?.trim() ||
                item.name!.trim(),
              aliases:
                Array.isArray(
                  item.aliases,
                )
                  ? item.aliases
                      .filter(
                        (
                          alias,
                        ): alias is string =>
                          typeof alias ===
                          'string',
                      )
                      .map(
                        (alias) =>
                          alias.trim(),
                      )
                      .filter(Boolean)
                  : [],
              category:
                item.category?.trim() ||
                null,
              tags:
                Array.isArray(
                  item.tags,
                )
                  ? item.tags
                      .filter(
                        (
                          tag,
                        ): tag is string =>
                          typeof tag ===
                          'string',
                      )
                      .map(
                        (tag) =>
                          tag.trim(),
                      )
                      .filter(Boolean)
                  : [],
            }),
          )
          .sort(
            (left, right) =>
              left.label.localeCompare(
                right.label,
                undefined,
                {
                  sensitivity:
                    'base',
                },
              ),
          );

      this.catalogCache = {
        expiresAt:
          now +
          this.productsCacheTtlMs,
        checkedAt:
          new Date().toISOString(),
        status:
          'AVAILABLE',
        products,
      };

      return this.catalogCache;
    } catch {
      if (
        stale &&
        stale.products.length > 0
      ) {
        this.catalogCache = {
          ...stale,
          expiresAt:
            now +
            UNAVAILABLE_CACHE_TTL_MS,
          status:
            'STALE',
        };

        return this.catalogCache;
      }

      this.catalogCache = {
        expiresAt:
          now +
          UNAVAILABLE_CACHE_TTL_MS,
        checkedAt:
          new Date().toISOString(),
        status:
          'UNAVAILABLE',
        products: [],
      };

      return this.catalogCache;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getProduct(
    product: string,
  ) {
    const now = Date.now();
    const cached =
      this.cache.get(product);

    if (
      cached &&
      cached.expiresAt > now
    ) {
      return cached.value;
    }

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        this.requestTimeoutMs,
      );

    try {
      const response =
        await fetch(
          `${this.apiBaseUrl}/products/${encodeURIComponent(product)}`,
          {
            headers: {
              Accept:
                'application/json',
              'User-Agent':
                'InfraStock/1.0',
            },
            signal:
              controller.signal,
          },
        );

      if (!response.ok) {
        throw new Error(
          `endoflife.date respondió HTTP ${response.status}`,
        );
      }

      const value =
        await response.json() as
          EndOfLifeApiResponse;

      this.cache.set(
        product,
        {
          expiresAt:
            now +
            this.cacheTtlMs,
          value,
        },
      );

      return value;
    } catch {
      if (cached?.value) {
        return cached.value;
      }

      this.cache.set(
        product,
        {
          expiresAt:
            now +
            UNAVAILABLE_CACHE_TTL_MS,
          value: null,
        },
      );

      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private analyzeVersion(
    installedVersion: string,
    releases: EndOfLifeRelease[],
  ) {
    const cycle =
      resolveReleaseCycle(
        installedVersion,
        releases,
      );

    if (!cycle) {
      return {
        installedVersion,
        cycle: null,
        status:
          'UNKNOWN' as SupportStatus,
        eolDate: null,
        daysToEol: null,
        latestInCycle: null,
        isLts: false,
      };
    }

    const daysToEol =
      this.daysUntil(
        cycle.eolFrom,
      );

    let status:
      SupportStatus =
        'SUPPORTED';

    if (
      cycle.isEol === true ||
      (
        daysToEol !== null &&
        daysToEol < 0
      )
    ) {
      status = 'EOL';
    } else if (
      daysToEol !== null &&
      daysToEol <=
        this.eolSoonDays
    ) {
      status = 'EOL_SOON';
    } else if (
      cycle.isMaintained ===
        false &&
      !cycle.eolFrom
    ) {
      status = 'UNKNOWN';
    }

    return {
      installedVersion,
      cycle:
        cycle.name,
      status,
      eolDate:
        cycle.eolFrom ??
        null,
      daysToEol,
      latestInCycle:
        cycle.latest?.name ??
        null,
      isLts:
        cycle.isLts === true,
    };
  }

  private buildRecommendation(
    releases: EndOfLifeRelease[],
  ) {
    const supported =
      releases.filter(
        (release) => {
          if (
            release.isEol ===
            true
          ) {
            return false;
          }

          const days =
            this.daysUntil(
              release.eolFrom,
            );

          return (
            days === null ||
            days >= 0
          );
        },
      );

    if (
      supported.length === 0
    ) {
      return null;
    }

    const dated =
      supported.filter(
        (release) =>
          this.daysUntil(
            release.eolFrom,
          ) !== null,
      );

    const pool =
      dated.length > 0
        ? dated
        : supported;

    const recommended =
      [...pool].sort(
        (left, right) => {
          const leftDays =
            this.daysUntil(
              left.eolFrom,
            ) ?? -1;
          const rightDays =
            this.daysUntil(
              right.eolFrom,
            ) ?? -1;

          if (
            leftDays !==
            rightDays
          ) {
            return (
              rightDays -
              leftDays
            );
          }

          if (
            left.isLts !==
            right.isLts
          ) {
            return left.isLts
              ? -1
              : 1;
          }

          return right.name.localeCompare(
            left.name,
            undefined,
            {
              numeric: true,
              sensitivity:
                'base',
            },
          );
        },
      )[0];

    return {
      cycle:
        recommended.name,
      latestVersion:
        recommended.latest?.name ??
        recommended.name,
      eolDate:
        recommended.eolFrom ??
        null,
      daysToEol:
        this.daysUntil(
          recommended.eolFrom,
        ),
      isLts:
        recommended.isLts === true,
    };
  }

  private daysUntil(
    date?: string | null,
  ) {
    if (!date) {
      return null;
    }

    const target =
      Date.parse(
        `${date}T00:00:00Z`,
      );

    if (
      Number.isNaN(target)
    ) {
      return null;
    }

    const today =
      new Date();

    const todayUtc =
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate(),
      );

    return Math.ceil(
      (
        target -
        todayUtc
      ) /
        86400000,
    );
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
}
