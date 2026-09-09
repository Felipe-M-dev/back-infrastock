import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

import type {
  Request,
  Response,
} from 'express';

import {
  randomUUID,
} from 'node:crypto';

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  stack?: unknown;
  cause?: unknown;
}

interface PrismaLikeError
  extends ErrorLike {
  clientVersion?: unknown;
  meta?: unknown;
}

@Catch()
export class GlobalExceptionFilter
  implements ExceptionFilter {
  private readonly logger =
    new Logger(
      GlobalExceptionFilter.name,
    );

  catch(
    exception: unknown,
    host: ArgumentsHost,
  ) {
    const http =
      host.switchToHttp();

    const request =
      http.getRequest<Request>();

    const response =
      http.getResponse<Response>();

    const requestId =
      this.resolveRequestId(
        request,
      );

    response.setHeader(
      'X-Request-Id',
      requestId,
    );

    if (
      exception instanceof
      HttpException
    ) {
      this.handleHttpException(
        exception,
        request,
        response,
        requestId,
      );
      return;
    }

    if (
      this.isDatabaseUnavailable(
        exception,
      )
    ) {
      this.logger.warn(
        [
          `requestId=${requestId}`,
          `method=${request.method}`,
          `path=${this.safePath(request)}`,
          `ip=${this.safeIp(request)}`,
          'status=503',
          'event=DATABASE_UNAVAILABLE',
        ].join(' '),
      );

      response
        .status(
          HttpStatus
            .SERVICE_UNAVAILABLE,
        )
        .json({
          statusCode:
            HttpStatus
              .SERVICE_UNAVAILABLE,
          message:
            'Servicio temporalmente no disponible',
          requestId,
        });

      return;
    }

    const error =
      this.asErrorLike(
        exception,
      );

    const errorName =
      typeof error.name ===
      'string'
        ? error.name
        : 'UnknownError';

    const errorMessage =
      typeof error.message ===
      'string'
        ? this.sanitizeMessage(
            error.message,
          )
        : 'Error no identificado';

    this.logger.error(
      [
        `requestId=${requestId}`,
        `method=${request.method}`,
        `path=${this.safePath(request)}`,
        `ip=${this.safeIp(request)}`,
        'status=500',
        'event=UNHANDLED_EXCEPTION',
        `error=${errorName}`,
        `message=${JSON.stringify(errorMessage)}`,
      ].join(' '),
      typeof error.stack ===
      'string'
        ? error.stack
        : undefined,
    );

    response
      .status(
        HttpStatus
          .INTERNAL_SERVER_ERROR,
      )
      .json({
        statusCode:
          HttpStatus
            .INTERNAL_SERVER_ERROR,
        message:
          'Error interno del servidor',
        requestId,
      });
  }

  private handleHttpException(
    exception: HttpException,
    request: Request,
    response: Response,
    requestId: string,
  ) {
    const status =
      exception.getStatus();

    const exceptionResponse =
      exception.getResponse();

    const body =
      typeof exceptionResponse ===
      'string'
        ? {
            statusCode: status,
            message:
              exceptionResponse,
          }
        : {
            ...exceptionResponse,
          };

    /*
     * Los 4xx son respuestas esperables de aplicación
     * (validación, permisos, sesión, etc.). No generamos
     * un stack trace global por cada una.
     *
     * Los eventos de autenticación relevantes se registran
     * explícitamente en AuthService.
     */
    if (status >= 500) {
      this.logger.warn(
        [
          `requestId=${requestId}`,
          `method=${request.method}`,
          `path=${this.safePath(request)}`,
          `ip=${this.safeIp(request)}`,
          `status=${status}`,
          'event=HTTP_EXCEPTION',
        ].join(' '),
      );
    }

    response
      .status(status)
      .json({
        ...body,
        requestId,
      });
  }

  private resolveRequestId(
    request: Request,
  ) {
    const incoming =
      request.header(
        'x-request-id',
      );

    if (
      incoming &&
      /^[A-Za-z0-9._:-]{1,100}$/.test(
        incoming,
      )
    ) {
      return incoming;
    }

    return randomUUID();
  }

  private isDatabaseUnavailable(
    exception: unknown,
  ) {
    const error =
      this.asPrismaLikeError(
        exception,
      );

    const codes =
      this.collectErrorCodes(
        error,
      );

    if (
      codes.some((code) =>
        [
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
          'EHOSTUNREACH',
          'ENETUNREACH',
          'P1001',
          'P1002',
          'P1017',
        ].includes(code),
      )
    ) {
      return true;
    }

    const message =
      typeof error.message ===
      'string'
        ? error.message
            .toLowerCase()
        : '';

    return (
      message.includes(
        "can't reach database server",
      ) ||
      message.includes(
        'connection refused',
      ) ||
      message.includes(
        'connection terminated unexpectedly',
      ) ||
      message.includes(
        'server has closed the connection',
      )
    );
  }

  private collectErrorCodes(
    error: PrismaLikeError,
  ) {
    const result: string[] =
      [];

    const visit = (
      value: unknown,
      depth = 0,
    ) => {
      if (
        depth > 3 ||
        !value ||
        typeof value !== 'object'
      ) {
        return;
      }

      const candidate =
        value as Record<
          string,
          unknown
        >;

      if (
        typeof candidate.code ===
        'string'
      ) {
        result.push(
          candidate.code,
        );
      }

      visit(
        candidate.cause,
        depth + 1,
      );
    };

    visit(error);

    return result;
  }

  private safePath(
    request: Request,
  ) {
    return (
      request.originalUrl
        ?.split('?')[0] ||
      request.path ||
      '/'
    );
  }

  private safeIp(
    request: Request,
  ) {
    return (
      request.ip ||
      request.socket
        .remoteAddress ||
      'unknown'
    );
  }

  private sanitizeMessage(
    message: string,
  ) {
    return message
      .replace(
        /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
        'Bearer [REDACTED]',
      )
      .replace(
        /postgres(?:ql)?:\/\/[^\s'"]+/gi,
        'postgresql://[REDACTED]',
      )
      .slice(0, 1000);
  }

  private asErrorLike(
    value: unknown,
  ): ErrorLike {
    if (
      value &&
      typeof value === 'object'
    ) {
      return value as ErrorLike;
    }

    return {
      message: String(value),
    };
  }

  private asPrismaLikeError(
    value: unknown,
  ): PrismaLikeError {
    return this.asErrorLike(
      value,
    ) as PrismaLikeError;
  }
}
