import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { MediaModule } from '../media/media.module.js';

import { CompaniesController } from './companies.controller.js';
import { CompaniesService } from './companies.service.js';

@Module({
  imports: [
    AuditModule,
    MediaModule,
  ],

  controllers: [
    CompaniesController,
  ],

  providers: [
    CompaniesService,
  ],
})
export class CompaniesModule {}
