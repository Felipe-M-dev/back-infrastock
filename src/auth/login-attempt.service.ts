import {
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

import {
  createHash,
} from 'node:crypto';

interface LoginAttemptState {
  firstFailureAt: number;
  failures: number;
  blockedUntil: number;
  lastSeenAt: number;
}

const DEFAULT_MAX_ATTEMPTS =
  8;
const DEFAULT_WINDOW_SECONDS =
  15 * 60;
const DEFAULT_BLOCK_SECONDS =
  15 * 60;
const MAX_TRACKED_KEYS =
  10_000;

function readPositiveInteger(
  name: string,
  fallback: number,
) {
  const raw =
    process.env[name]?.trim();

  if (!raw) {
    return fallback;
  }

  const value =
    Number.parseInt(
      raw,
      10,
    );

  if (
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new Error(
      `${name} debe ser un entero mayor o igual a 1`,
    );
  }

  return value;
}

@Injectable()
export class LoginAttemptService {
  private readonly attempts =
    new Map<
      string,
      LoginAttemptState
    >();

  private readonly maxAttempts =
    readPositiveInteger(
      'LOGIN_MAX_ATTEMPTS',
      DEFAULT_MAX_ATTEMPTS,
    );

  private readonly windowMs =
    readPositiveInteger(
      'LOGIN_WINDOW_SECONDS',
      DEFAULT_WINDOW_SECONDS,
    ) * 1000;

  private readonly blockMs =
    readPositiveInteger(
      'LOGIN_BLOCK_SECONDS',
      DEFAULT_BLOCK_SECONDS,
    ) * 1000;

  assertAllowed(
    username: string,
    ipAddress: string,
  ) {
    const now =
      Date.now();
    const key =
      this.buildKey(
        username,
        ipAddress,
      );

    this.prune(now);

    const current =
      this.attempts.get(key);

    if (!current) {
      return;
    }

    current.lastSeenAt = now;

    if (
      current.blockedUntil > now
    ) {
      throw new HttpException(
        'Demasiados intentos de inicio de sesión. Intenta nuevamente más tarde.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      now -
        current.firstFailureAt >=
      this.windowMs
    ) {
      this.attempts.delete(key);
    }
  }

  registerFailure(
    username: string,
    ipAddress: string,
  ) {
    const now =
      Date.now();
    const key =
      this.buildKey(
        username,
        ipAddress,
      );

    this.prune(now);

    const current =
      this.attempts.get(key);

    if (
      !current ||
      now -
        current.firstFailureAt >=
        this.windowMs
    ) {
      this.attempts.set(
        key,
        {
          firstFailureAt: now,
          failures: 1,
          blockedUntil: 0,
          lastSeenAt: now,
        },
      );

      return;
    }

    current.failures += 1;
    current.lastSeenAt = now;

    if (
      current.failures >=
      this.maxAttempts
    ) {
      current.blockedUntil =
        now + this.blockMs;
    }
  }

  registerSuccess(
    username: string,
    ipAddress: string,
  ) {
    this.attempts.delete(
      this.buildKey(
        username,
        ipAddress,
      ),
    );
  }

  private buildKey(
    username: string,
    ipAddress: string,
  ) {
    return createHash(
      'sha256',
    )
      .update(
        `${username.trim().toLowerCase()}\u0000${ipAddress}`,
        'utf8',
      )
      .digest('hex');
  }

  private prune(
    now: number,
  ) {
    for (
      const [key, state]
      of this.attempts
    ) {
      const staleAt =
        Math.max(
          state.blockedUntil,
          state.firstFailureAt +
            this.windowMs,
        );

      if (staleAt <= now) {
        this.attempts.delete(key);
      }
    }

    while (
      this.attempts.size >
      MAX_TRACKED_KEYS
    ) {
      const oldestKey =
        this.attempts.keys()
          .next().value as
          | string
          | undefined;

      if (!oldestKey) {
        break;
      }

      this.attempts.delete(
        oldestKey,
      );
    }
  }
}
