import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';

import { OperatingSystemsController } from './operating-systems.controller.js';
import { OperatingSystemsService } from './operating-systems.service.js';

@Module({
  imports: [
    AuditModule,
  ],

  controllers: [
    OperatingSystemsController,
  ],

  providers: [
    OperatingSystemsService,
  ],
})
export class OperatingSystemsModule {}
