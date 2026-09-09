import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { CompaniesModule } from './companies/companies.module.js';
import { CredentialsModule } from './credentials/credentials.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { HealthModule } from './health/health.module.js';
import { OperatingSystemsModule } from './operating-systems/operating-systems.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ServersModule } from './servers/servers.module.js';
import { SoftwareModule } from './software/software.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    UsersModule,
    AuthModule,
    ServersModule,
    OperatingSystemsModule,
    SoftwareModule,
    DashboardModule,
    CompaniesModule,
    PricingModule,
    CredentialsModule,
    HealthModule,
  ],

  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },

    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
