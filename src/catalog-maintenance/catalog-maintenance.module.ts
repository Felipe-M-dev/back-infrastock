import { Module } from '@nestjs/common';

import { CatalogMaintenanceController } from './catalog-maintenance.controller.js';
import { CatalogMaintenanceService } from './catalog-maintenance.service.js';

@Module({
  controllers: [
    CatalogMaintenanceController,
  ],

  providers: [
    CatalogMaintenanceService,
  ],
})
export class CatalogMaintenanceModule {}
