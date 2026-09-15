import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-auth.guard.js';
import { isPersonalVaultSupervisor } from '../auth/personal-vault-policy.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CredentialCryptoService } from './credential-crypto.service.js';
import { CredentialSecretAccessService } from './credential-secret-access.service.js';
import type {
  CreatePersonalCredentialDto,
  PersonalCredentialQueryDto,
  UpdatePersonalCredentialDto,
} from './dto/personal-credential.dto.js';

// Never use a full record in list/create/update responses: encrypted material
// and passwords only belong to the explicitly authorized copy operation.
const metadata = {
  id: true,
  ownerId: true,
  name: true,
  username: true,
  location: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PersonalCredentialSelect;

@Injectable()
export class PersonalCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCryptoService,
    private readonly secretAccess: CredentialSecretAccessService,
  ) {}

  private async resolveOwner(actor: JwtPayload, requestedOwner?: number) {
    const account = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      select: { id: true, username: true, role: true, active: true },
    });
    if (!account?.active)
      throw new UnauthorizedException('La cuenta no está activa');
    const ownerId = requestedOwner ?? account.id;
    if (ownerId !== account.id && !isPersonalVaultSupervisor(account)) {
      throw new ForbiddenException(
        'Solo la cuenta admin puede consultar credenciales personales de otros usuarios',
      );
    }
    return ownerId;
  }

  private audit(
    tx: Prisma.TransactionClient,
    actorId: number,
    ownerId: number,
    action: string,
    entityId?: number,
  ) {
    return tx.auditLog.create({
      data: {
        action,
        entityType: 'PERSONAL_CREDENTIAL',
        entityId,
        entityName: 'Credencial personal',
        userId: actorId,
        // Do not place names, account identifiers, notes or secrets in general audit.
        details: {
          ownerId,
          access: ownerId === actorId ? 'OWNER' : 'SUPERVISOR',
        },
      },
    });
  }

  async list(
    actor: JwtPayload,
    query: PersonalCredentialQueryDto,
    requestedOwner?: number,
  ) {
    const ownerId = await this.resolveOwner(actor, requestedOwner);
    const where: Prisma.PersonalCredentialWhereInput = {
      ownerId,
      ...(query.search
        ? {
            OR: ['name', 'username', 'location'].map((field) => ({
              [field]: { contains: query.search, mode: 'insensitive' },
            })),
          }
        : {}),
    };
    return this.prisma.$transaction(async (tx) => {
      const owner = await tx.user.findUnique({
        where: { id: ownerId },
        select: { id: true, username: true, name: true },
      });
      if (!owner) throw new NotFoundException('Usuario no encontrado');
      const total = await tx.personalCredential.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
      const page = Math.min(query.page, totalPages);
      const items = await tx.personalCredential.findMany({
        where,
        select: metadata,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * query.pageSize,
        take: query.pageSize,
      });
      if (ownerId !== actor.sub)
        await this.audit(tx, actor.sub, ownerId, 'VIEW');
      return {
        items,
        total,
        page,
        pageSize: query.pageSize,
        totalPages,
        owner,
      };
    });
  }

  async create(actor: JwtPayload, dto: CreatePersonalCredentialDto) {
    const ownerId = await this.resolveOwner(actor);
    const encrypted = this.crypto.encrypt(dto.password);
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.personalCredential.create({
        data: {
          ownerId,
          name: dto.name,
          username: dto.username,
          location: dto.location || null,
          notes: dto.notes || null,
          ...encrypted,
        },
        select: metadata,
      });
      await this.audit(tx, actor.sub, ownerId, 'CREATE', item.id);
      return item;
    });
  }

  async update(
    actor: JwtPayload,
    id: number,
    dto: UpdatePersonalCredentialDto,
  ) {
    const ownerId = await this.resolveOwner(actor);
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.personalCredential.findFirst({
        where: { id, ownerId },
        select: { id: true },
      });
      if (!item)
        throw new NotFoundException('Credencial personal no encontrada');
      const updated = await tx.personalCredential.update({
        where: { id, ownerId },
        data: {
          name: dto.name,
          username: dto.username,
          location:
            dto.location === undefined ? undefined : dto.location || null,
          notes: dto.notes === undefined ? undefined : dto.notes || null,
          ...(dto.password === undefined
            ? {}
            : this.crypto.encrypt(dto.password)),
        },
        select: metadata,
      });
      await this.audit(tx, actor.sub, ownerId, 'UPDATE', id);
      return updated;
    });
  }

  async remove(actor: JwtPayload, id: number) {
    const ownerId = await this.resolveOwner(actor);
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.personalCredential.deleteMany({
        where: { id, ownerId },
      });
      if (!result.count)
        throw new NotFoundException('Credencial personal no encontrada');
      await this.audit(tx, actor.sub, ownerId, 'DELETE', id);
      return { message: 'Credencial personal eliminada' };
    });
  }

  async copyPassword(actor: JwtPayload, id: number, requestedOwner?: number) {
    const ownerId = await this.resolveOwner(actor, requestedOwner);
    // Separate rate-limit keys from the general vault, which uses positive IDs.
    this.secretAccess.assertAllowed(actor.sub, -id);
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.personalCredential.findFirst({
        where: { id, ownerId },
      });
      if (!item)
        throw new NotFoundException('Credencial personal no encontrada');
      const password = this.crypto.decrypt(item);
      await this.audit(tx, actor.sub, ownerId, 'COPY_PASSWORD', id);
      return { password };
    });
  }
}
