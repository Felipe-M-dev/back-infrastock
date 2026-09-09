import {
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

import { createHash } from 'node:crypto';

interface SecretAccessState {
  windowStartedAt: number;
  accesses: number;
  blockedUntil: number;
  lastSeenAt: number;
}

const DEFAULT_MAX_ACCESSES = 20;
const DEFAULT_WINDOW_SECONDS = 10 * 60;
const DEFAULT_BLOCK_SECONDS = 10 * 60;
const MAX_TRACKED_KEYS = 10_000;

function readPositiveInteger(
  name: string,
  fallback: number,
) {
  const raw = process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} debe ser un entero mayor o igual a 1`,
    );
  }

  return value;
}

@Injectable()
export class CredentialSecretAccessService {
  private readonly accesses =
    new Map<string, SecretAccessState>();

  private readonly maxAccesses =
    readPositiveInteger(
      'CREDENTIAL_SECRET_MAX_ACCESSES',
      DEFAULT_MAX_ACCESSES,
    );

  private readonly windowMs =
    readPositiveInteger(
      'CREDENTIAL_SECRET_WINDOW_SECONDS',
      DEFAULT_WINDOW_SECONDS,
    ) * 1000;

  private readonly blockMs =
    readPositiveInteger(
      'CREDENTIAL_SECRET_BLOCK_SECONDS',
      DEFAULT_BLOCK_SECONDS,
    ) * 1000;

  assertAllowed(
    userId: number,
    credentialId: number,
  ) {
    const now = Date.now();
    const key = this.buildKey(
      userId,
      credentialId,
    );

    this.prune(now);

    const current =
      this.accesses.get(key);

    if (!current) {
      this.accesses.set(key, {
        windowStartedAt: now,
        accesses: 1,
        blockedUntil: 0,
        lastSeenAt: now,
      });
      return;
    }

    current.lastSeenAt = now;

    if (current.blockedUntil > now) {
      throw new HttpException(
        'Demasiadas consultas de contraseña para esta credencial. Intenta nuevamente más tarde.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      now - current.windowStartedAt >=
      this.windowMs
    ) {
      current.windowStartedAt = now;
      current.accesses = 1;
      current.blockedUntil = 0;
      return;
    }

    current.accesses += 1;

    if (
      current.accesses >
      this.maxAccesses
    ) {
      current.blockedUntil =
        now + this.blockMs;

      throw new HttpException(
        'Demasiadas consultas de contraseña para esta credencial. Intenta nuevamente más tarde.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private buildKey(
    userId: number,
    credentialId: number,
  ) {
    return createHash('sha256')
      .update(
        `${userId}\u0000${credentialId}`,
        'utf8',
      )
      .digest('hex');
  }

  private prune(now: number) {
    for (const [key, state] of this.accesses) {
      const staleAt = Math.max(
        state.blockedUntil,
        state.windowStartedAt +
          this.windowMs,
      );

      if (staleAt <= now) {
        this.accesses.delete(key);
      }
    }

    while (
      this.accesses.size >
      MAX_TRACKED_KEYS
    ) {
      const oldestKey =
        this.accesses.keys()
          .next().value as
          | string
          | undefined;

      if (!oldestKey) {
        break;
      }

      this.accesses.delete(oldestKey);
    }
  }
}
