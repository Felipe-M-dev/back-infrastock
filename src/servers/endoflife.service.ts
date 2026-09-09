import { Injectable } from '@nestjs/common';

type SupportStatus =
  | 'SUPPORTED'
  | 'EOL_SOON'
  | 'EOL'
  | 'UNKNOWN';

interface EndOfLifeRelease {
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
    label?: string;
    releases?: EndOfLifeRelease[];
  };
}

interface CachedProduct {
  expiresAt: number;
  value: EndOfLifeApiResponse | null;
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

@Injectable()
export class EndOfLifeService {
  private readonly cache =
    new Map<string, CachedProduct>();

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

  getEolSoonDays() {
    return this.eolSoonDays;
  }

  async analyzeSoftware(
    softwareName: string,
    installedVersions: string[],
  ) {
    const product =
      this.resolveProduct(
        softwareName,
      );

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
            product,
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

  private resolveProduct(
    softwareName: string,
  ) {
    return PRODUCT_ALIASES[
      softwareName
        .trim()
        .toLocaleLowerCase()
    ] ?? null;
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
    product: string,
    installedVersion: string,
    releases: EndOfLifeRelease[],
  ) {
    const cycle =
      this.resolveCycle(
        product,
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

  private resolveCycle(
    product: string,
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

    const candidates =
      product === 'postgresql' ||
      product === 'nodejs' ||
      product === 'docker-engine'
        ? [parts[0]]
        : [
            parts
              .slice(0, 2)
              .join('.'),
            parts[0],
          ];

    for (
      const candidate of
      candidates
    ) {
      const release =
        releases.find(
          (item) =>
            item.name ===
              candidate ||
            item.label ===
              candidate,
        );

      if (release) {
        return release;
      }
    }

    return null;
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
}
