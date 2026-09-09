import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { NetworksController } from '../networks/networks.controller.js';
import { NetworksService } from '../networks/networks.service.js';
import { ServerImportsController } from '../server-imports/server-imports.controller.js';
import { ServerImportsService } from '../server-imports/server-imports.service.js';

import { EndOfLifeService } from './endoflife.service.js';
import { ServersCatalogService } from './servers-catalog.service.js';
import { ServersController } from './servers.controller.js';
import { ServersService } from './servers.service.js';

@Module({
  imports: [
    AuditModule,
  ],

  controllers: [
    ServersController,
    NetworksController,
    ServerImportsController,
  ],

  providers: [
    ServersService,
    ServersCatalogService,
    EndOfLifeService,
    NetworksService,
    ServerImportsService,
  ],
})
export class ServersModule {}
