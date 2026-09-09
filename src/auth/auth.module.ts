import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_EXPIRES_IN,
  JWT_ISSUER,
  JWT_SECRET,
} from './jwt.config.js';
import { LoginAttemptService } from './login-attempt.service.js';

@Module({
  imports: [
    UsersModule,

    JwtModule.register({
      global: true,
      secret: JWT_SECRET,
      signOptions: {
        algorithm: JWT_ALGORITHM,
        expiresIn: JWT_EXPIRES_IN,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    }),
  ],

  controllers: [AuthController],
  providers: [
    AuthService,
    LoginAttemptService,
  ],
})
export class AuthModule {}
