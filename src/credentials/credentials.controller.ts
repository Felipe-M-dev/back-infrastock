import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import {
  Role,
} from '@prisma/client';

import type {
  Request,
} from 'express';

import {
  Roles,
} from '../auth/roles.decorator.js';

import {
  AssignCredentialDto,
} from './dto/assign-credential.dto.js';

import {
  CreateCredentialDto,
} from './dto/create-credential.dto.js';

import {
  CredentialQueryDto,
} from './dto/credential-query.dto.js';

import {
  UpdateCredentialDto,
} from './dto/update-credential.dto.js';

import {
  CredentialSecretAccessService,
} from './credential-secret-access.service.js';

import {
  CredentialsService,
  type CredentialCurrentUser,
} from './credentials.service.js';

interface AuthenticatedRequest
  extends Request {
  user:
    CredentialCurrentUser;
}

@Controller('credentials')
@Roles(
  Role.ADMIN,
)
export class CredentialsController {
  constructor(
    private readonly credentialsService:
      CredentialsService,

    private readonly credentialSecretAccessService:
      CredentialSecretAccessService,
  ) {}

  @Get()
  findAll(
    @Query()
    query:
      CredentialQueryDto,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.findAll(
      query,
      request.user,
    );
  }

  @Get(':id/usage')
  getUsage(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.getUsage(
      id,
      request.user,
    );
  }

  @Get(':id')
  findOne(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.findOne(
      id,
      request.user,
    );
  }

  @Post()
  @Roles(
    Role.ADMIN,
  )
  create(
    @Body()
    dto:
      CreateCredentialDto,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.create(
      dto,
      request.user,
    );
  }

  @Patch(':id')
  @Roles(
    Role.ADMIN,
  )
  update(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Body()
    dto:
      UpdateCredentialDto,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.update(
      id,
      dto,
      request.user,
    );
  }

  @Patch(':id/deactivate')
  @Roles(
    Role.ADMIN,
  )
  deactivate(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.deactivate(
      id,
      request.user,
    );
  }

  @Post(':id/copy-password')
  @HttpCode(HttpStatus.OK)
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private',
  )
  @Header(
    'Pragma',
    'no-cache',
  )
  copyPassword(
    @Param(
      'id',
      ParseIntPipe,
    )
    id: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    this.credentialSecretAccessService.assertAllowed(
      request.user.sub,
      id,
    );

    return this.credentialsService.copyPassword(
      id,
      request.user,
    );
  }

  @Get(
    'assignments/server/:serverId',
  )
  listServerAssignments(
    @Param(
      'serverId',
      ParseIntPipe,
    )
    serverId: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.listServerAssignments(
      serverId,
      request.user,
    );
  }

  @Post(
    'assignments/server/:serverId',
  )
  assignToServer(
    @Param(
      'serverId',
      ParseIntPipe,
    )
    serverId: number,

    @Body()
    dto:
      AssignCredentialDto,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.assignToServer(
      serverId,
      dto,
      request.user,
    );
  }

  @Delete(
    'assignments/server/:serverId/:credentialId',
  )
  unassignFromServer(
    @Param(
      'serverId',
      ParseIntPipe,
    )
    serverId: number,

    @Param(
      'credentialId',
      ParseIntPipe,
    )
    credentialId: number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.unassignFromServer(
      serverId,
      credentialId,
      request.user,
    );
  }

  @Get(
    'assignments/server-software/:serverSoftwareId',
  )
  listServerSoftwareAssignments(
    @Param(
      'serverSoftwareId',
      ParseIntPipe,
    )
    serverSoftwareId:
      number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.listServerSoftwareAssignments(
      serverSoftwareId,
      request.user,
    );
  }

  @Post(
    'assignments/server-software/:serverSoftwareId',
  )
  assignToServerSoftware(
    @Param(
      'serverSoftwareId',
      ParseIntPipe,
    )
    serverSoftwareId:
      number,

    @Body()
    dto:
      AssignCredentialDto,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.assignToServerSoftware(
      serverSoftwareId,
      dto,
      request.user,
    );
  }

  @Delete(
    'assignments/server-software/:serverSoftwareId/:credentialId',
  )
  unassignFromServerSoftware(
    @Param(
      'serverSoftwareId',
      ParseIntPipe,
    )
    serverSoftwareId:
      number,

    @Param(
      'credentialId',
      ParseIntPipe,
    )
    credentialId:
      number,

    @Req()
    request:
      AuthenticatedRequest,
  ) {
    return this.credentialsService.unassignFromServerSoftware(
      serverSoftwareId,
      credentialId,
      request.user,
    );
  }
}
