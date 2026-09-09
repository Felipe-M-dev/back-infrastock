import type {
  NextFunction,
  Request,
  Response,
} from 'express';

import {
  randomUUID,
} from 'node:crypto';

const SAFE_REQUEST_ID =
  /^[A-Za-z0-9._:-]{1,100}$/;

export function requestContextMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const incoming =
    request.header(
      'x-request-id',
    );

  const requestId =
    incoming &&
    SAFE_REQUEST_ID.test(
      incoming,
    )
      ? incoming
      : randomUUID();

  response.setHeader(
    'X-Request-Id',
    requestId,
  );

  /*
   * Express permite propiedades personalizadas en runtime.
   * Evitamos incluir body, Authorization o cookies.
   */
  (
    request as Request & {
      requestId?: string;
    }
  ).requestId =
    requestId;

  next();
}
