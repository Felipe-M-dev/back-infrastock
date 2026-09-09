import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';

import { SoftwareController } from './software.controller.js';
import { SoftwareService } from './software.service.js';

@Module({
  imports: [
    AuditModule,
  ],

  controllers: [
    SoftwareController,
  ],

  providers: [
    SoftwareService,
  ],
})
export class SoftwareModule {}
