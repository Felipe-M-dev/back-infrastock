import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import {
  Prisma,
  Role,
} from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service.js';

export interface CompanyScopedUser {
  role: Role;
  companyId: number | null;
}

export async function getAccessibleCompanyIds(
  prisma: PrismaService,
  currentUser: CompanyScopedUser,
): Promise<number[] | null> {
  if (currentUser.role === Role.ADMIN) {
    return null;
  }

  if (!currentUser.companyId) {
    return [];
  }

  const accessRows =
    await prisma.companyAccess.findMany({
      where: {
        sourceCompanyId:
          currentUser.companyId,

        targetCompany: {
          active: true,
        },
      },

      select: {
        targetCompanyId: true,
      },
    });

  return Array.from(
    new Set([
      currentUser.companyId,
      ...accessRows.map(
        (item) =>
          item.targetCompanyId,
      ),
    ]),
  );
}

export async function assertCompanyAccessible(
  prisma: PrismaService,
  currentUser: CompanyScopedUser,
  companyId: number,
) {
  const company =
    await prisma.company.findUnique({
      where: {
        id: companyId,
      },

      select: {
        id: true,
        active: true,
      },
    });

  if (!company) {
    throw new NotFoundException(
      'Empresa no encontrada',
    );
  }

  if (currentUser.role === Role.ADMIN) {
    return company;
  }

  const accessibleCompanyIds =
    await getAccessibleCompanyIds(
      prisma,
      currentUser,
    );

  if (
    !accessibleCompanyIds?.includes(
      companyId,
    )
  ) {
    throw new ForbiddenException(
      'No tienes acceso a esta empresa',
    );
  }

  return company;
}


export async function assertActiveCompanyAccessible(
  prisma: PrismaService,
  currentUser: CompanyScopedUser,
  companyId: number,
) {
  const company =
    await assertCompanyAccessible(
      prisma,
      currentUser,
      companyId,
    );

  if (!company.active) {
    throw new ConflictException(
      'La empresa está inactiva y no puede recibir nuevas asignaciones',
    );
  }

  return company;
}

export async function buildScopedServerCompanyWhere(
  prisma: PrismaService,
  currentUser: CompanyScopedUser,
  requestedCompanyId?: number,
): Promise<Prisma.ServerWhereInput> {
  if (
    requestedCompanyId !==
    undefined
  ) {
    await assertCompanyAccessible(
      prisma,
      currentUser,
      requestedCompanyId,
    );

    return {
      companyId:
        requestedCompanyId,
    };
  }

  if (currentUser.role === Role.ADMIN) {
    return {};
  }

  const accessibleCompanyIds =
    await getAccessibleCompanyIds(
      prisma,
      currentUser,
    );

  if (
    !accessibleCompanyIds ||
    accessibleCompanyIds.length ===
      0
  ) {
    return {
      companyId: -1,
    };
  }

  return {
    companyId: {
      in: accessibleCompanyIds,
    },
  };
}

export async function getAccessibleCompanies(
  prisma: PrismaService,
  currentUser: CompanyScopedUser,
) {
  const accessibleCompanyIds =
    await getAccessibleCompanyIds(
      prisma,
      currentUser,
    );

  return prisma.company.findMany({
    where: {
      active: true,

      ...(accessibleCompanyIds ===
      null
        ? {}
        : {
            id: {
              in:
                accessibleCompanyIds,
            },
          }),
    },

    select: {
      id: true,
      name: true,
      slug: true,
      logoUrl: true,
      primaryColor: true,
      secondaryColor: true,
      backgroundColor: true,
      surfaceColor: true,
      textColor: true,
      active: true,
    },

    orderBy: {
      name: 'asc',
    },
  });
}
