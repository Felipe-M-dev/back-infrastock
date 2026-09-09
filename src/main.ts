import 'dotenv/config';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type {
  NextFunction,
  Request,
  Response,
} from 'express';
import { resolve } from 'node:path';

import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { requestContextMiddleware } from './common/middleware/request-context.middleware.js';

function readAllowedOrigins() {
  const configured =
    process.env.FRONTEND_URLS ??
    process.env.FRONTEND_URL ??
    '';

  return configured
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTrustProxyHops() {
  const raw =
    process.env.TRUST_PROXY_HOPS?.trim();

  if (!raw) {
    return 0;
  }

  const value =
    Number.parseInt(
      raw,
      10,
    );

  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > 10
  ) {
    throw new Error(
      'TRUST_PROXY_HOPS debe ser un entero entre 0 y 10',
    );
  }

  return value;
}

async function bootstrap() {
  const app =
    await NestFactory.create<NestExpressApplication>(
      AppModule,
    );

  const expressApp =
    app.getHttpAdapter().getInstance();

  expressApp.disable(
    'x-powered-by',
  );

  const trustProxyHops =
    readTrustProxyHops();

  if (trustProxyHops > 0) {
    expressApp.set(
      'trust proxy',
      trustProxyHops,
    );
  }

  /*
   * requestId se genera antes del resto de middlewares
   * para poder correlacionar respuestas y errores.
   */
  app.use(
    requestContextMiddleware,
  );

  app.use(
    (
      request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      response.setHeader(
        'X-Content-Type-Options',
        'nosniff',
      );
      response.setHeader(
        'X-Frame-Options',
        'DENY',
      );
      response.setHeader(
        'Referrer-Policy',
        'no-referrer',
      );
      response.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()',
      );
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );

      const sensitivePath =
        request.path.startsWith('/auth/') ||
        request.path.startsWith('/credentials') ||
        request.path.startsWith('/audit') ||
        request.path.startsWith('/users');

      if (sensitivePath) {
        response.setHeader(
          'Cache-Control',
          'no-store, no-cache, must-revalidate, private',
        );
        response.setHeader(
          'Pragma',
          'no-cache',
        );
      }

      next();
    },
  );

  const allowedOrigins =
    readAllowedOrigins();

  if (
    allowedOrigins.length === 0
  ) {
    throw new Error(
      'Debes configurar FRONTEND_URL o FRONTEND_URLS',
    );
  }

  app.enableCors({
    origin: (
      origin,
      callback,
    ) => {
      if (
        !origin ||
        allowedOrigins.includes(
          origin,
        )
      ) {
        callback(null, true);
        return;
      }

      callback(
        new Error(
          'Origen CORS no permitido',
        ),
      );
    },
    methods: [
      'GET',
      'HEAD',
      'POST',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Request-Id',
    ],
    exposedHeaders: [
      'Content-Disposition',
      'X-Request-Id',
    ],
    credentials: false,
    optionsSuccessStatus: 204,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(
    new GlobalExceptionFilter(),
  );

  app.useStaticAssets(
    resolve(
      process.env.MEDIA_STORAGE_DIR ??
        './storage/media',
    ),
    {
      prefix: '/uploads/',
      fallthrough: false,
      maxAge: '7d',
      dotfiles: 'deny',
      index: false,
    },
  );

  app.enableShutdownHooks();

  await app.listen(
    process.env.PORT ??
      3000,
  );
}

void bootstrap();
