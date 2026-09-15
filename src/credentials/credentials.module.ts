import {
  Module,
} from '@nestjs/common';

import {
  AuditModule,
} from '../audit/audit.module.js';

import {
  CredentialCryptoService,
} from './credential-crypto.service.js';

import {
  CredentialSecretAccessService,
} from './credential-secret-access.service.js';

import {
  CredentialsController,
} from './credentials.controller.js';

import {
  CredentialsService,
} from './credentials.service.js';
import { PersonalCredentialsController } from './personal-credentials.controller.js';
import { PersonalCredentialsService } from './personal-credentials.service.js';

@Module({
  imports: [
    AuditModule,
  ],

  controllers: [
    CredentialsController,
    PersonalCredentialsController,
  ],

  providers: [
    CredentialsService,
    CredentialCryptoService,
    CredentialSecretAccessService,
    PersonalCredentialsService,
  ],

  exports: [
    CredentialsService,
  ],
})
export class CredentialsModule {}
