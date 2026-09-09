import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { MediaModule } from '../media/media.module.js';

import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [
    AuditModule,
    MediaModule,
  ],
  controllers: [
    UsersController,
  ],
  providers: [
    UsersService,
  ],
  exports: [
    UsersService,
  ],
})
export class UsersModule {}
