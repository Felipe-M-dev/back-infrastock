import type { SignOptions } from 'jsonwebtoken';

const DEFAULT_ISSUER =
  'infrastock-api';
const DEFAULT_AUDIENCE =
  'infrastock-web';
const MIN_SECRET_BYTES =
  32;

function readJwtSecret() {
  const value =
    process.env.JWT_SECRET?.trim();

  if (!value) {
    throw new Error(
      'JWT_SECRET no está definida',
    );
  }

  if (
    Buffer.byteLength(
      value,
      'utf8',
    ) < MIN_SECRET_BYTES
  ) {
    throw new Error(
      `JWT_SECRET debe contener al menos ${MIN_SECRET_BYTES} bytes`,
    );
  }

  return value;
}

export const JWT_SECRET =
  readJwtSecret();

export const JWT_EXPIRES_IN = (
  process.env.JWT_EXPIRES_IN ??
  '8h'
) as SignOptions['expiresIn'];

export const JWT_ISSUER =
  process.env.JWT_ISSUER?.trim() ||
  DEFAULT_ISSUER;

export const JWT_AUDIENCE =
  process.env.JWT_AUDIENCE?.trim() ||
  DEFAULT_AUDIENCE;

export const JWT_ALGORITHM =
  'HS256' as const;
