import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';

import type { UploadedMediaFile } from '../media/media-storage.service.js';
import { UsersService } from '../users/users.service.js';
import { LoginDto } from './dto/login.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { LoginAttemptService } from './login-attempt.service.js';

@Injectable()
export class AuthService {
  private readonly logger =
    new Logger(AuthService.name);

  constructor(
    private readonly usersService:
      UsersService,

    private readonly jwtService:
      JwtService,

    private readonly loginAttemptService:
      LoginAttemptService,
  ) {}

  async login(
    loginDto: LoginDto,
    ipAddress: string,
  ) {
    const username =
      loginDto.username.trim();
    const password =
      loginDto.password;

    try {
      this.loginAttemptService.assertAllowed(
        username,
        ipAddress,
      );
    } catch (error) {
      if (
        error instanceof
          HttpException &&
        error.getStatus() ===
          HttpStatus
            .TOO_MANY_REQUESTS
      ) {
        this.logger.warn(
          [
            'event=LOGIN_BLOCKED',
            `user=${this.safeLogValue(username)}`,
            `ip=${this.safeLogValue(ipAddress)}`,
          ].join(' '),
        );
      }

      throw error;
    }

    const user =
      await this.usersService.findByUsername(
        username,
      );

    const dummyPasswordHash =
      '$2b$12$mYCPPld2PTBXsJP7WlARleXWen1xB16EE1.ksrBgxGX/ZkTynRxvS';

    const passwordValid =
      await bcrypt.compare(
        password,
        user?.passwordHash ??
          dummyPasswordHash,
      );

    if (
      !user ||
      !passwordValid ||
      !user.active ||
      !user.company ||
      !user.company.active
    ) {
      this.loginAttemptService.registerFailure(
        username,
        ipAddress,
      );

      this.logger.warn(
        [
          'event=LOGIN_FAILED',
          `user=${this.safeLogValue(username)}`,
          `ip=${this.safeLogValue(ipAddress)}`,
        ].join(' '),
      );

      throw new UnauthorizedException(
        'Usuario o contraseña incorrectos',
      );
    }

    this.loginAttemptService.registerSuccess(
      username,
      ipAddress,
    );

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      companyId: user.company.id,
      tokenVersion: user.tokenVersion,
    };

    const accessToken =
      await this.jwtService.signAsync(
        payload,
      );

    this.logger.log(
      [
        'event=LOGIN_SUCCESS',
        `userId=${user.id}`,
        `user=${this.safeLogValue(user.username)}`,
        `role=${user.role}`,
        `companyId=${user.company.id}`,
        `ip=${this.safeLogValue(ipAddress)}`,
      ].join(' '),
    );

    return {
      accessToken,
      user:
        this.toSessionUser(
          user,
        ),
    };
  }

  async getProfile(
    userId: number,
  ) {
    const user =
      await this.usersService.findOne(
        userId,
      );

    const fullUser =
      await this.usersService.findByUsername(
        user.username,
      );

    if (!fullUser) {
      throw new UnauthorizedException(
        'Usuario no disponible',
      );
    }

    return this.toSessionUser(
      fullUser,
    );
  }

  async updateProfile(
    userId: number,
    dto: UpdateProfileDto,
  ) {
    const current =
      await this.usersService.findOne(
        userId,
      );

    const fullCurrent =
      await this.usersService.findByUsername(
        current.username,
      );

    if (
      !fullCurrent ||
      !fullCurrent.active
    ) {
      throw new UnauthorizedException(
        'Usuario no disponible',
      );
    }

    if (
      !fullCurrent.company ||
      !fullCurrent.company.active
    ) {
      throw new UnauthorizedException(
        'Empresa no disponible',
      );
    }

    const name =
      dto.name !== undefined
        ? dto.name.trim()
        : undefined;

    const email =
      dto.email !== undefined
        ? dto.email.trim()
        : undefined;

    if (
      dto.name !== undefined &&
      !name
    ) {
      throw new BadRequestException(
        'El nombre no puede estar vacío',
      );
    }

    if (
      dto.password !== undefined
    ) {
      if (
        !dto.currentPassword
      ) {
        throw new BadRequestException(
          'Debes informar la contraseña actual para cambiar la contraseña',
        );
      }

      const currentPasswordValid =
        await bcrypt.compare(
          dto.currentPassword,
          fullCurrent.passwordHash,
        );

      if (
        !currentPasswordValid
      ) {
        throw new UnauthorizedException(
          'La contraseña actual es incorrecta',
        );
      }

      const samePassword =
        await bcrypt.compare(
          dto.password,
          fullCurrent.passwordHash,
        );

      if (
        samePassword
      ) {
        throw new BadRequestException(
          'La nueva contraseña debe ser distinta de la contraseña actual',
        );
      }
    }

    await this.usersService.update(
      userId,
      {
        name,
        email:
          email ||
          undefined,
        password:
          dto.password ||
          undefined,
      },
      {
        sub:
          current.id,
        username:
          current.username,
        role:
          current.role,
        companyId:
          current.companyId,
      },
    );

    const updated =
      await this.usersService.findByUsername(
        current.username,
      );

    if (!updated) {
      throw new UnauthorizedException(
        'Usuario no disponible',
      );
    }

    return this.toSessionUser(
      updated,
    );
  }

  async updateAvatar(
    userId: number,
    file: UploadedMediaFile,
  ) {
    await this.usersService.updateOwnAvatar(
      userId,
      file,
    );

    return this.getProfile(userId);
  }

  async removeAvatar(
    userId: number,
  ) {
    await this.usersService.removeOwnAvatar(
      userId,
    );

    return this.getProfile(userId);
  }

  private safeLogValue(
    value: string,
  ) {
    return JSON.stringify(
      value
        .replace(
          /[\r\n\t]/g,
          ' ',
        )
        .slice(0, 200),
    );
  }

  private toSessionUser(
    user: any,
  ) {
    if (
      !user.company ||
      !user.company.active
    ) {
      throw new UnauthorizedException(
        'Empresa no disponible',
      );
    }

    return {
      id:
        user.id,
      username:
        user.username,
      name:
        user.name,
      email:
        user.email,
      avatarUrl:
        user.avatarUrl ?? null,
      role:
        user.role,
      company: {
        id:
          user.company.id,
        name:
          user.company.name,
        slug:
          user.company.slug,
        logoUrl:
          user.company.logoUrl,
        primaryColor:
          user.company.primaryColor,
        secondaryColor:
          user.company.secondaryColor,
        backgroundColor:
          user.company.backgroundColor,
        surfaceColor:
          user.company.surfaceColor,
        textColor:
          user.company.textColor,
        logoBackgroundColor:
          user.company.logoBackgroundColor,
      },
    };
  }
}
