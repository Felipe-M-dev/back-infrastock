import {
  CatalogMaintenanceService,
} from './catalog-maintenance.service.js';

function createService(
  tx: Record<string, unknown>,
) {
  const prisma = {
    $transaction: async (
      callback: (
        client: Record<string, unknown>,
      ) => Promise<unknown>,
    ) => callback(tx),
  };

  return new CatalogMaintenanceService(
    prisma as never,
  );
}

const ADMIN_USER = {
  sub: 1,
  username: 'admin',
  companyId: null,
};

describe('CatalogMaintenanceService', () => {
  it('elimina software sin uso y registra auditoría', async () => {
    let deleted = false;
    let audited = false;

    const tx = {
      software: {
        findUnique: async () => ({
          id: 99,
          name: 'DELETE TEST APP',
          category: 'OTHER',
          active: true,
          eolProductKey: null,
        }),
        delete: async () => {
          deleted = true;
        },
      },
      serverSoftware: {
        count: async () => 0,
      },
      pricingTariff: {
        count: async () => 0,
      },
      auditLog: {
        create: async () => {
          audited = true;
        },
      },
    };

    const service =
      createService(tx);

    const result =
      await service.deleteSoftware(
        99,
        ADMIN_USER,
      );

    expect(result).toEqual({
      deleted: true,
      id: 99,
      name: 'DELETE TEST APP',
    });
    expect(deleted).toBe(true);
    expect(audited).toBe(true);
  });

  it('bloquea software instalado en servidores', async () => {
    let deleted = false;

    const tx = {
      software: {
        findUnique: async () => ({
          id: 5,
          name: 'Docker',
          category:
            'CONTAINER_ORCHESTRATION',
          active: true,
          eolProductKey:
            'docker-engine',
        }),
        delete: async () => {
          deleted = true;
        },
      },
      serverSoftware: {
        count: async () => 3,
      },
      pricingTariff: {
        count: async () => 0,
      },
      auditLog: {
        create: async () => undefined,
      },
    };

    const service =
      createService(tx);

    await expect(
      service.deleteSoftware(
        5,
        ADMIN_USER,
      ),
    ).rejects.toThrow(
      'está instalado en 3 servidores',
    );

    expect(deleted).toBe(false);
  });

  it('elimina un SO sin servidores ni tarifas huérfanas', async () => {
    let deleted = false;
    let audited = false;

    const tx = {
      operatingSystem: {
        findUnique: async () => ({
          id: 100,
          name: 'DELETE TEST OS',
          version: '1.0',
          active: true,
          eolProductKey: null,
        }),
        count: async () => 0,
        delete: async () => {
          deleted = true;
        },
      },
      server: {
        count: async () => 0,
      },
      pricingTariff: {
        count: async () => 0,
      },
      auditLog: {
        create: async () => {
          audited = true;
        },
      },
    };

    const service =
      createService(tx);

    const result =
      await service.deleteOperatingSystem(
        100,
        ADMIN_USER,
      );

    expect(result).toEqual({
      deleted: true,
      id: 100,
      name: 'DELETE TEST OS',
      version: '1.0',
    });
    expect(deleted).toBe(true);
    expect(audited).toBe(true);
  });

  it('bloquea un SO asignado a servidores', async () => {
    let deleted = false;

    const tx = {
      operatingSystem: {
        findUnique: async () => ({
          id: 10,
          name: 'Redhat Linux',
          version: '9.8',
          active: true,
          eolProductKey: 'rhel',
        }),
        count: async () => 1,
        delete: async () => {
          deleted = true;
        },
      },
      server: {
        count: async () => 4,
      },
      pricingTariff: {
        count: async () => 0,
      },
      auditLog: {
        create: async () => undefined,
      },
    };

    const service =
      createService(tx);

    await expect(
      service.deleteOperatingSystem(
        10,
        ADMIN_USER,
      ),
    ).rejects.toThrow(
      'está asignado a 4 servidores',
    );

    expect(deleted).toBe(false);
  });
});
