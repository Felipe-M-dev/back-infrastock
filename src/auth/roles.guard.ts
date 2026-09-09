import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';

import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

import { ROLES_KEY } from './roles.decorator.js';

interface AuthenticatedUser {
  sub: number;
  username: string;
  role: Role;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
  ) {}

  canActivate(
    context: ExecutionContext,
  ): boolean {
    const requiredRoles =
      this.reflector.getAllAndOverride<Role[]>(
        ROLES_KEY,
        [
          context.getHandler(),
          context.getClass(),
        ],
      );

    if (
      !requiredRoles ||
      requiredRoles.length === 0
    ) {
      return true;
    }

    const request =
      context.switchToHttp().getRequest<{
        user?: AuthenticatedUser;
      }>();

    const user = request.user;

    if (!user) {
      return false;
    }

    return requiredRoles.includes(
      user.role,
    );
  }
}