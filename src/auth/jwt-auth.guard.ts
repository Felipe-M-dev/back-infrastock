import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './jwt.config.js';

export interface JwtPayload {
  sub: number;
  username: string;
  role: Role;
  companyId: number | null;
  tokenVersion: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(
    context: ExecutionContext,
  ): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(
        IS_PUBLIC_KEY,
        [
          context.getHandler(),
          context.getClass(),
        ],
      );

    if (isPublic) {
      return true;
    }

    const request =
      context.switchToHttp().getRequest<
        Request & { user?: JwtPayload }
      >();

    const token =
      this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException(
        'Token no informado',
      );
    }

    let tokenPayload:
      JwtPayload;

    try {
      tokenPayload =
        await this.jwtService.verifyAsync<JwtPayload>(
          token,
          {
            algorithms: [
              JWT_ALGORITHM,
            ],
            issuer:
              JWT_ISSUER,
            audience:
              JWT_AUDIENCE,
          },
        );
    } catch {
      throw new UnauthorizedException(
        'Token inválido o expirado',
      );
    }

    /*
     * El JWT acredita que la sesión fue emitida por InfraStock,
     * pero no debe ser la fuente definitiva del estado actual
     * del usuario.
     *
     * Consultamos la cuenta en cada request protegido para que
     * una desactivación, eliminación, cambio de rol o cambio de
     * empresa tenga efecto inmediatamente, sin esperar a que el
     * token expire.
     */
    const currentUser =
      await this.prisma.user.findUnique({
        where: {
          id:
            tokenPayload.sub,
        },

        select: {
          id:
            true,

          username:
            true,

          role:
            true,

          active:
            true,

          companyId:
            true,

          tokenVersion:
            true,

          company: {
            select: {
              id:
                true,

              active:
                true,
            },
          },
        },
      });

    if (
      !currentUser ||
      !currentUser.active
    ) {
      throw new UnauthorizedException(
        'Usuario no disponible',
      );
    }

    /*
     * AuthService.login() exige una empresa activa. Repetimos
     * aquí la misma condición para impedir que un JWT ya emitido
     * siga funcionando si posteriormente la empresa se elimina,
     * se desactiva o el usuario queda sin empresa.
     */
    if (
      !currentUser.company ||
      !currentUser.company.active
    ) {
      throw new UnauthorizedException(
        'Empresa no disponible',
      );
    }

    /*
     * tokenVersion invalida inmediatamente todas las sesiones
     * emitidas antes de un cambio o restablecimiento de contraseña.
     * Los tokens antiguos que no contienen tokenVersion también
     * quedan invalidados al activar este mecanismo.
     */
    if (
      tokenPayload.tokenVersion !==
      currentUser.tokenVersion
    ) {
      throw new UnauthorizedException(
        'Sesión invalidada',
      );
    }

    /*
     * Sobrescribimos los datos provenientes del token con el
     * estado vigente de base de datos. De esta manera RolesGuard
     * y los servicios de company-scope trabajan con role y
     * companyId actuales, no con valores obsoletos del JWT.
     */
    request.user = {
      sub:
        currentUser.id,

      username:
        currentUser.username,

      role:
        currentUser.role,

      companyId:
        currentUser.companyId,

      tokenVersion:
        currentUser.tokenVersion,
    };

    return true;
  }

  private extractToken(
    request: Request,
  ): string | undefined {
    const authorization =
      request.headers.authorization;

    if (!authorization) {
      return undefined;
    }

    const [type, token] =
      authorization.split(' ');

    return type === 'Bearer'
      ? token
      : undefined;
  }
}
