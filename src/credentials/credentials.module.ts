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

@Module({
  imports: [
    AuditModule,
  ],

  controllers: [
    CredentialsController,
  ],

  providers: [
    CredentialsService,
    CredentialCryptoService,
    CredentialSecretAccessService,
  ],

  exports: [
    CredentialsService,
  ],
})
export class CredentialsModule {}
