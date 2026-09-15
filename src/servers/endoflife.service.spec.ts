import {
  normalizeEndOfLifeName,
  resolveExactCatalogProduct,
  resolveReleaseCycle,
  suggestCatalogProduct,
  type EndOfLifeProductSummary,
} from './endoflife.service.js';

const PRODUCTS: EndOfLifeProductSummary[] = [
  {
    name: 'docker-engine',
    label: 'Docker Engine',
    aliases: [],
    category: 'app',
    tags: ['app'],
  },
  {
    name: 'apache-tomcat',
    label: 'Apache Tomcat',
    aliases: [],
    category: 'server-app',
    tags: ['java'],
  },
  {
    name: 'nodejs',
    label: 'Node.js',
    aliases: [],
    category: 'lang',
    tags: ['javascript'],
  },
];

describe('EndOfLife helpers', () => {
  it('normaliza nombres sin depender de mayúsculas, acentos o puntuación', () => {
    expect(
      normalizeEndOfLifeName(
        '  Nóde.JS  ',
      ),
    ).toBe('node js');
  });

  it('resuelve coincidencias exactas por label sin hacer fuzzy matching automático', () => {
    expect(
      resolveExactCatalogProduct(
        'Node.js',
        PRODUCTS,
      )?.name,
    ).toBe('nodejs');

    expect(
      resolveExactCatalogProduct(
        'Tomcat Server',
        PRODUCTS,
      ),
    ).toBeNull();
  });

  it('propone una coincidencia parcial sin convertirla en resolución automática', () => {
    expect(
      suggestCatalogProduct(
        'Tomcat Server',
        PRODUCTS,
      )?.name,
    ).toBe('apache-tomcat');
  });

  it('resuelve Docker por ciclo major.minor', () => {
    const cycle =
      resolveReleaseCycle(
        '25.0.17',
        [
          {
            name: '25.0',
            label: '25.0',
          },
          {
            name: '24.0',
            label: '24.0',
          },
        ],
      );

    expect(cycle?.name).toBe(
      '25.0',
    );
  });

  it('mantiene compatibilidad con ciclos major como PostgreSQL y Node.js', () => {
    expect(
      resolveReleaseCycle(
        '17.6',
        [
          {
            name: '17',
          },
        ],
      )?.name,
    ).toBe('17');

    expect(
      resolveReleaseCycle(
        'v24.20.0',
        [
          {
            name: '24',
          },
        ],
      )?.name,
    ).toBe('24');
  });
});
