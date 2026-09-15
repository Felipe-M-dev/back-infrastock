import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma, Role } from '@prisma/client';

import JSZip from 'jszip';

import { readFile } from 'node:fs/promises';

import { dirname, join } from 'node:path';

import { fileURLToPath } from 'node:url';

import { getAccessibleCompanyIds } from '../company-scope/company-scope.js';

import { isUsableIpv4InCidr } from '../networks/ipv4-cidr.js';

import { PrismaService } from '../prisma/prisma.service.js';

import type { JwtPayload } from '../auth/jwt-auth.guard.js';

import type { CreateProviderQuotationDto } from './dto/create-provider-quotation.dto.js';

interface ProviderQuotationContext {
  user: {
    id: number;
    name: string;
    email: string;
    phone: string;
  };
  company: {
    id: number;
    name: string;
  };
  operatingSystem: {
    id: number;
    name: string;
    version: string;
  };
  databaseSoftware: {
    id: number;
    name: string;
  } | null;
  network: {
    id: number;
    name: string;
    cidr: string;
  };
  hostname: string;
  ipAddress: string;
  environment: string | null;
}

export interface ProviderQuotationResult {
  buffer: Buffer;
  filename: string;
  serverId: number;
  hostname: string;
}

@Injectable()
export class ProviderQuotationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateProviderQuotationDto,
    currentUser: JwtPayload,
  ): Promise<ProviderQuotationResult> {
    const hostname = dto.reference.trim();

    const ipAddress = dto.ipAddress.trim();

    if (!hostname) {
      throw new BadRequestException('La referencia es obligatoria');
    }

    const accessibleCompanyIds = await getAccessibleCompanyIds(
      this.prisma,
      currentUser,
    );

    if (
      accessibleCompanyIds !== null &&
      !accessibleCompanyIds.includes(dto.companyId)
    ) {
      throw new BadRequestException(
        'No tienes acceso a la empresa seleccionada',
      );
    }

    const context = await this.loadContext(
      dto,
      currentUser,
      hostname,
      ipAddress,
    );

    const buffer = await this.buildWorkbook(dto, context);

    try {
      const serverId = await this.prisma.$transaction(
        async (tx) =>
          this.createServerAndReservation(
            tx,
            dto,
            currentUser,
            accessibleCompanyIds,
            context,
          ),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      return {
        buffer,
        filename: `${this.safeFilename(hostname)}.xlsx`,
        serverId,
        hostname,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException(
            'El hostname o la IP ya fueron utilizados mientras se procesaba la solicitud',
          );
        }

        if (error.code === 'P2034') {
          throw new ConflictException(
            'La solicitud coincidió con otra operación simultánea. Actualiza las IP disponibles e inténtalo nuevamente',
          );
        }
      }

      throw error;
    }
  }

  private async loadContext(
    dto: CreateProviderQuotationDto,
    currentUser: JwtPayload,
    hostname: string,
    ipAddress: string,
  ): Promise<ProviderQuotationContext> {
    const [
      user,
      company,
      operatingSystem,
      databaseSoftware,
      network,
      existingServer,
      existingIp,
      activeReservation,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: {
          id: currentUser.sub,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          active: true,
        },
      }),
      this.prisma.company.findUnique({
        where: {
          id: dto.companyId,
        },
        select: {
          id: true,
          name: true,
          active: true,
        },
      }),
      this.prisma.operatingSystem.findUnique({
        where: {
          id: dto.operatingSystemId,
        },
        select: {
          id: true,
          name: true,
          version: true,
          active: true,
        },
      }),
      dto.databaseSoftwareId
        ? this.prisma.software.findUnique({
            where: {
              id: dto.databaseSoftwareId,
            },
            select: {
              id: true,
              name: true,
              category: true,
              active: true,
            },
          })
        : Promise.resolve(null),
      this.prisma.network.findUnique({
        where: {
          id: dto.networkId,
        },
        select: {
          id: true,
          name: true,
          cidr: true,
          active: true,
        },
      }),
      this.prisma.server.findUnique({
        where: {
          hostname,
        },
        select: {
          id: true,
        },
      }),
      this.prisma.server.findUnique({
        where: {
          ipAddress,
        },
        select: {
          id: true,
          hostname: true,
        },
      }),
      this.prisma.ipReservation.findUnique({
        where: {
          ipAddress,
        },
        select: {
          active: true,
          description: true,
        },
      }),
    ]);

    if (!user?.active) {
      throw new BadRequestException(
        'El usuario autenticado no está disponible',
      );
    }

    const email = user.email?.trim();

    const phone = user.phone?.trim();

    if (!email || !phone) {
      throw new BadRequestException(
        'Completa el correo y el teléfono de tu perfil antes de generar la solicitud XLSX',
      );
    }

    if (!company) {
      throw new NotFoundException('Empresa no encontrada');
    }

    if (!company.active) {
      throw new ConflictException('La empresa seleccionada está inactiva');
    }

    if (!operatingSystem) {
      throw new NotFoundException('Sistema operativo no encontrado');
    }

    if (!operatingSystem.active) {
      throw new ConflictException(
        'El sistema operativo seleccionado está inactivo',
      );
    }

    if (dto.databaseSoftwareId && !databaseSoftware) {
      throw new NotFoundException('Motor de base de datos no encontrado');
    }

    if (
      databaseSoftware &&
      (!databaseSoftware.active || databaseSoftware.category !== 'DATABASE')
    ) {
      throw new ConflictException(
        'El software seleccionado no es un motor de base de datos activo',
      );
    }

    if (!network) {
      throw new NotFoundException('Red/VLAN no encontrada');
    }

    if (!network.active) {
      throw new ConflictException('La red/VLAN seleccionada está inactiva');
    }

    if (!isUsableIpv4InCidr(ipAddress, network.cidr)) {
      throw new BadRequestException(
        'La IP no pertenece al rango utilizable de la red/VLAN seleccionada',
      );
    }

    if (existingServer) {
      throw new ConflictException('Ya existe un servidor con esa referencia');
    }

    if (existingIp) {
      throw new ConflictException(
        `La IP está vinculada al servidor ${existingIp.hostname}`,
      );
    }

    if (activeReservation?.active) {
      throw new ConflictException(
        activeReservation.description
          ? `La IP está reservada: ${activeReservation.description}`
          : 'La IP está reservada',
      );
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        email,
        phone,
      },
      company: {
        id: company.id,
        name: company.name,
      },
      operatingSystem: {
        id: operatingSystem.id,
        name: operatingSystem.name,
        version: operatingSystem.version,
      },
      databaseSoftware: databaseSoftware
        ? {
            id: databaseSoftware.id,
            name: databaseSoftware.name,
          }
        : null,
      network: {
        id: network.id,
        name: network.name,
        cidr: network.cidr,
      },
      hostname,
      ipAddress,
      environment: this.inferEnvironment(hostname),
    };
  }

  private async buildWorkbook(
    dto: CreateProviderQuotationDto,
    context: ProviderQuotationContext,
  ): Promise<Buffer> {
    const templatePath = join(
      dirname(fileURLToPath(import.meta.url)),
      'templates',
      'sk-gwy-doc1-prd.xlsx',
    );

    let template: Buffer;

    try {
      template = await readFile(templatePath);
    } catch {
      throw new BadRequestException(
        'La plantilla XLSX del proveedor no está disponible',
      );
    }

    const zip = await JSZip.loadAsync(template);

    const sheetPath = 'xl/worksheets/sheet1.xml';

    const sheetFile = zip.file(sheetPath);

    if (!sheetFile) {
      throw new BadRequestException(
        'La plantilla XLSX no contiene la hoja Equipo-1',
      );
    }

    const requestedAt = new Date();

    let sheetXml = await sheetFile.async('string');

    sheetXml = this.setNumericCell(
      sheetXml,
      'B4',
      this.toExcelDateSerial(requestedAt),
    );
    sheetXml = this.setTextCell(sheetXml, 'B5', context.company.name);
    sheetXml = this.setTextCell(sheetXml, 'B6', context.user.name);
    sheetXml = this.setTextCell(sheetXml, 'D6', context.user.email);
    sheetXml = this.setTextCell(sheetXml, 'E6', context.user.phone);
    sheetXml = this.setTextCell(sheetXml, 'B18', context.hostname);
    sheetXml = this.setTextCell(
      sheetXml,
      'B20',
      this.getOperatingSystemFamily(context.operatingSystem.name),
    );
    sheetXml = this.setTextCell(
      sheetXml,
      'C20',
      `${context.operatingSystem.name} ${context.operatingSystem.version}`.trim(),
    );
    sheetXml = this.setTextCell(sheetXml, 'D20', dto.architecture);
    sheetXml = this.setTextCell(sheetXml, 'E20', 'Ingles');
    sheetXml = this.setTextCell(
      sheetXml,
      'B22',
      context.databaseSoftware?.name ?? null,
    );
    sheetXml = this.setTextCell(sheetXml, 'A26', `${dto.cpuCores} vCPU`);
    sheetXml = this.setTextCell(sheetXml, 'B26', `${dto.ramGb} GB vRAM`);
    sheetXml = this.setNumericCell(sheetXml, 'C26', dto.diskGb);
    sheetXml = this.setTextCell(sheetXml, 'A39', context.network.name);
    sheetXml = this.setTextCell(sheetXml, 'B39', context.ipAddress);

    zip.file(sheetPath, sheetXml);

    return zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6,
      },
    });
  }

  private setTextCell(
    sheetXml: string,
    address: string,
    value: string | null,
  ): string {
    return this.replaceCell(sheetXml, address, (styleAttribute) =>
      value === null
        ? `<c r="${address}"${styleAttribute}/>`
        : `<c r="${address}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${this.escapeXml(value)}</t></is></c>`,
    );
  }

  private setNumericCell(
    sheetXml: string,
    address: string,
    value: number,
  ): string {
    if (!Number.isFinite(value)) {
      throw new BadRequestException(
        `El valor destinado a la celda ${address} no es válido`,
      );
    }

    return this.replaceCell(
      sheetXml,
      address,
      (styleAttribute) =>
        `<c r="${address}"${styleAttribute}><v>${value}</v></c>`,
    );
  }

  private replaceCell(
    sheetXml: string,
    address: string,
    buildCell: (styleAttribute: string) => string,
  ): string {
    const escapedAddress = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const cellPattern = new RegExp(
      `<c\\b(?=[^>]*\\br="${escapedAddress}")[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`,
    );

    const currentCell = sheetXml.match(cellPattern)?.[0];

    if (!currentCell) {
      throw new BadRequestException(
        `La plantilla XLSX no contiene la celda ${address}`,
      );
    }

    const style = currentCell.match(/\bs="([^"]+)"/)?.[1];

    const replacement = buildCell(style ? ` s="${style}"` : '');

    return sheetXml.replace(cellPattern, replacement);
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private toExcelDateSerial(value: Date): number {
    return (
      Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) /
        86_400_000 +
      25_569
    );
  }

  private async createServerAndReservation(
    tx: Prisma.TransactionClient,
    dto: CreateProviderQuotationDto,
    currentUser: JwtPayload,
    accessibleCompanyIds: number[] | null,
    context: ProviderQuotationContext,
  ): Promise<number> {
    const company = await tx.company.findUnique({
      where: {
        id: context.company.id,
      },
      select: {
        active: true,
      },
    });

    if (!company?.active) {
      throw new ConflictException(
        'La empresa seleccionada dejó de estar disponible',
      );
    }

    if (
      currentUser.role !== Role.ADMIN &&
      !accessibleCompanyIds?.includes(context.company.id)
    ) {
      throw new BadRequestException(
        'No tienes acceso a la empresa seleccionada',
      );
    }

    /*
     * Una transacción interactiva utiliza una única conexión PostgreSQL.
     * Estas consultas deben ejecutarse secuencialmente para no invocar
     * client.query() mientras la misma conexión aún procesa otra consulta.
     */
    const existingHostname = await tx.server.findUnique({
      where: {
        hostname: context.hostname,
      },
      select: {
        id: true,
      },
    });

    const existingIp = await tx.server.findUnique({
      where: {
        ipAddress: context.ipAddress,
      },
      select: {
        id: true,
      },
    });

    const network = await tx.network.findUnique({
      where: {
        id: context.network.id,
      },
      select: {
        id: true,
        cidr: true,
        active: true,
      },
    });

    const operatingSystem = await tx.operatingSystem.findUnique({
      where: {
        id: context.operatingSystem.id,
      },
      select: {
        active: true,
      },
    });

    const databaseSoftware = context.databaseSoftware
      ? await tx.software.findUnique({
          where: {
            id: context.databaseSoftware.id,
          },
          select: {
            active: true,
            category: true,
          },
        })
      : null;

    const reservation = await tx.ipReservation.findUnique({
      where: {
        ipAddress: context.ipAddress,
      },
      select: {
        id: true,
        active: true,
      },
    });

    if (existingHostname || existingIp) {
      throw new ConflictException(
        'El hostname o la IP dejaron de estar disponibles',
      );
    }

    if (
      !network?.active ||
      !isUsableIpv4InCidr(context.ipAddress, network.cidr)
    ) {
      throw new ConflictException(
        'La red/VLAN o la IP dejaron de estar disponibles',
      );
    }

    if (!operatingSystem?.active) {
      throw new ConflictException(
        'El sistema operativo dejó de estar disponible',
      );
    }

    if (
      context.databaseSoftware &&
      (!databaseSoftware?.active || databaseSoftware.category !== 'DATABASE')
    ) {
      throw new ConflictException(
        'El motor de base de datos dejó de estar disponible',
      );
    }

    if (reservation?.active) {
      throw new ConflictException('La IP dejó de estar disponible');
    }

    const server = await tx.server.create({
      data: {
        hostname: context.hostname,
        ipAddress: null,
        environment: context.environment,
        cpuCores: dto.cpuCores,
        ramGb: dto.ramGb,
        diskGb: dto.diskGb,
        notes: `Solicitud XLSX proveedor. IP reservada: ${context.ipAddress}`,
        active: false,
        servicesOnitec: true,
        companyId: context.company.id,
        operatingSystemId: context.operatingSystem.id,
        createdById: currentUser.sub,
        updatedById: currentUser.sub,
        software: context.databaseSoftware
          ? {
              create: {
                softwareId: context.databaseSoftware.id,
                version: 'No informada',
              },
            }
          : undefined,
      },
    });

    const description = `Aprovisionamiento pendiente para ${server.hostname}`;

    if (reservation) {
      await tx.ipReservation.update({
        where: {
          id: reservation.id,
        },
        data: {
          networkId: context.network.id,
          description,
          active: true,
          provisioningServerId: server.id,
        },
      });
    } else {
      await tx.ipReservation.create({
        data: {
          networkId: context.network.id,
          ipAddress: context.ipAddress,
          description,
          active: true,
          provisioningServerId: server.id,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        action: 'CREATE',
        entityType: 'SERVER',
        entityId: server.id,
        entityName: server.hostname,
        userId: currentUser.sub,
        companyId: server.companyId,
        details: {
          message: 'Solicitud XLSX generada y servidor inactivo registrado',
          fields: [
            'hostname',
            'companyId',
            'operatingSystemId',
            'cpuCores',
            'ramGb',
            'diskGb',
            'active',
            'provisioningIp',
          ],
          provisioningIp: context.ipAddress,
          networkId: context.network.id,
          databaseSoftwareId: context.databaseSoftware?.id ?? null,
        },
      },
    });

    return server.id;
  }

  private getOperatingSystemFamily(name: string) {
    const normalized = name.toLocaleUpperCase('en-US');

    if (normalized.includes('WINDOWS')) {
      return 'WINDOWS';
    }

    if (normalized.includes('AIX')) {
      return 'AIX';
    }

    if (
      ['LINUX', 'RED HAT', 'RHEL', 'DEBIAN', 'UBUNTU'].some((item) =>
        normalized.includes(item),
      )
    ) {
      return 'LINUX';
    }

    return 'OTRO';
  }

  private inferEnvironment(hostname: string) {
    const match = hostname
      .toLocaleUpperCase('en-US')
      .match(/(?:^|[-_])(PRD|QAS|DEV)(?:$|[-_])/);

    return match?.[1] ?? null;
  }

  private safeFilename(value: string) {
    return (
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'servidor'
    );
  }
}
