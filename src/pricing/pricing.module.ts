import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';

import { PricingController } from './pricing.controller.js';
import { PricingService } from './pricing.service.js';
import { ProviderQuotationService } from './provider-quotation.service.js';

@Module({
  imports: [
    AuditModule,
  ],

  controllers: [
    PricingController,
  ],

  providers: [
    PricingService,
    ProviderQuotationService,
  ],
})
export class PricingModule {}
