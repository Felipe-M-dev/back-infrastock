import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  Prisma,
  Role,
} from '@prisma/client';

import {
  isIP,
} from 'node:net';

import ExcelJS from 'exceljs';

import { getAccessibleCompanies } from '../company-scope/company-scope.js';
import { isUsableIpv4InCidr } from '../networks/ipv4-cidr.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ServersService } from '../servers/servers.service.js';

interface CurrentUser {
  sub: number;
  username: string;
  role: Role;
  companyId: number | null;
}

interface UploadedImportFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export type ServerImportAction =
  | 'CREATE'
  | 'UPDATE'
  | 'REACTIVATE'
  | 'SKIP';

interface ImportSoftwareItem {
  softwareId: number;
  name: string;
  version: string;
}

interface NormalizedImportRow {
  hostname: string;
  companyId: number;
  companyName: string;
  environment: 'PRD' | 'QAS' | 'DEV' | null;
  ipAddress: string | null;
  operatingSystemId: number | null;
  operatingSystemLabel: string | null;
  cpuCores: number | null;
  ramGb: number | null;
  diskGb: number | null;
  active: boolean;
  notes: string | null;
  software: ImportSoftwareItem[];
  existingServerId: number | null;
  existingServerActive: boolean | null;
}

interface ParsedSourceRow {
  rowNumber: number;
  values: Record<string, string>;
}

interface PreviewRow {
  rowNumber: number;
  rawData: Record<string, string>;
  normalizedData: NormalizedImportRow | null;
  suggestedAction: ServerImportAction;
  validationStatus: 'VALID' | 'ERROR';
  errors: string[];
  warnings: string[];
}

interface ConfirmDecision {
  rowId: number;
  action: ServerImportAction;
}

interface XlsxZipEntry {
  fileName: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  generalPurposeFlags: number;
}

const DEFAULT_PROCESSING_TIMEOUT_MINUTES = 30;
const MAX_PROCESSING_TIMEOUT_MINUTES = 24 * 60;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 1000;

// XLSX is a ZIP container. These limits are checked against the ZIP central
// directory before ExcelJS is allowed to decompress the workbook.
const MAX_XLSX_ZIP_ENTRIES = 2000;
const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = 200;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

const REQUIRED_HEADERS = [
  'hostname',
  'empresa',
  'ambiente',
  'ip',
  'so_nombre',
  'so_version',
  'cpu_cores',
  'ram_gb',
  'disco_gb',
  'activo',
  'notas',
  'software',
] as const;

@Injectable()
export class ServerImportsService {
  private readonly logger = new Logger(ServerImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly serversService: ServersService,
  ) {}

  async buildTemplate(
    currentUser: CurrentUser,
  ): Promise<Buffer> {
    const [companies, operatingSystems] =
      await Promise.all([
        getAccessibleCompanies(
          this.prisma,
          currentUser,
        ),

        this.prisma.operatingSystem.findMany({
          where: {
            active: true,
          },

          select: {
            name: true,
            version: true,
          },

          orderBy: [
            {
              name: 'asc',
            },
            {
              version: 'asc',
            },
          ],
        }),
      ]);

    const workbook =
      new ExcelJS.Workbook();

    workbook.creator =
      'InfraStock';

    const sheet =
      workbook.addWorksheet(
        'Servidores',
      );

    sheet.columns = [
      { header: 'hostname', key: 'hostname', width: 28 },
      { header: 'empresa', key: 'empresa', width: 22 },
      { header: 'ambiente', key: 'ambiente', width: 14 },
      { header: 'ip', key: 'ip', width: 18 },
      { header: 'so_nombre', key: 'so_nombre', width: 22 },
      { header: 'so_version', key: 'so_version', width: 16 },
      { header: 'cpu_cores', key: 'cpu_cores', width: 14 },
      { header: 'ram_gb', key: 'ram_gb', width: 12 },
      { header: 'disco_gb', key: 'disco_gb', width: 14 },
      { header: 'activo', key: 'activo', width: 12 },
      { header: 'notas', key: 'notas', width: 34 },
      { header: 'software', key: 'software', width: 52 },
    ];

    const currentCompany =
      currentUser.companyId
        ? companies.find(
            (company) =>
              company.id ===
              currentUser.companyId,
          )
        : undefined;

    const exampleCompany =
      currentCompany ??
      companies[0] ??
      null;

    const preferredOperatingSystems =
      operatingSystems
        .filter(
          (item) =>
            item.name
              .trim()
              .toLowerCase() ===
            'redhat linux',
        )
        .sort((left, right) =>
          right.version.localeCompare(
            left.version,
            undefined,
            {
              numeric: true,
              sensitivity: 'base',
            },
          ),
        );

    const exampleOperatingSystem =
      preferredOperatingSystems[0] ??
      operatingSystems[0] ??
      null;

    sheet.addRow({
      hostname: 'srv-ejemplo-01',
      empresa:
        exampleCompany?.name ?? '',
      ambiente: 'PRD',
      ip: '172.20.4.10',
      so_nombre:
        exampleOperatingSystem?.name ??
        '',
      so_version:
        exampleOperatingSystem?.version ??
        '',
      cpu_cores: 4,
      ram_gb: 16,
      disco_gb: 200,
      activo: 'SI',
      notas:
        'Fila de ejemplo. Eliminar antes de importar.',
      software:
        'PostgreSQL=17.10;Node.js=24.20.0',
    });

    sheet.views = [
      {
        state: 'frozen',
        ySplit: 1,
      },
    ];

    sheet.getRow(1).font = {
      bold: true,
    };

    sheet.getRow(1).height = 24;

    sheet.getRow(1).eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb: 'FF1E293B',
        },
      };

      cell.font = {
        bold: true,
        color: {
          argb: 'FFFFFFFF',
        },
      };

      cell.alignment = {
        vertical: 'middle',
      };
    });

    const selectorHeaderCells = [
      'B1',
      'C1',
      'E1',
      'F1',
      'J1',
    ];

    for (const address of selectorHeaderCells) {
      sheet.getCell(address).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb: 'FF2563EB',
        },
      };
    }

    sheet.getCell('B1').note =
      'Empresa: seleccione una celda de esta columna y use la lista desplegable. La lista contiene todas las empresas activas a las que su usuario tiene acceso.';

    sheet.getCell('C1').note =
      'Ambiente: seleccione PRD, QAS o DEV desde la lista desplegable.';

    sheet.getCell('E1').note =
      'Sistema operativo: seleccione un nombre activo desde la lista desplegable.';

    sheet.getCell('F1').note =
      'Versión de SO: seleccione una versión activa. InfraStock validará que corresponda al sistema operativo elegido.';

    sheet.getCell('J1').note =
      'Activo: seleccione SI o NO desde la lista desplegable.';

    sheet.getColumn('K').alignment = {
      wrapText: true,
      vertical: 'top',
    };

    sheet.getColumn('L').alignment = {
      wrapText: true,
      vertical: 'top',
    };

    const catalogSheet =
      workbook.addWorksheet(
        'Catalogos',
      );

    catalogSheet.columns = [
      {
        header: 'Empresas accesibles',
        key: 'company',
        width: 34,
      },
      {
        header: 'Sistemas operativos',
        key: 'osName',
        width: 34,
      },
      {
        header: 'Versiones SO',
        key: 'osVersion',
        width: 22,
      },
    ];

    const operatingSystemNames =
      Array.from(
        new Set(
          operatingSystems.map(
            (item) => item.name,
          ),
        ),
      );

    const operatingSystemVersions =
      Array.from(
        new Set(
          operatingSystems.map(
            (item) => item.version,
          ),
        ),
      ).sort((left, right) =>
        left.localeCompare(
          right,
          undefined,
          {
            numeric: true,
            sensitivity: 'base',
          },
        ),
      );

    const catalogRows = Math.max(
      companies.length,
      operatingSystemNames.length,
      operatingSystemVersions.length,
      1,
    );

    for (
      let index = 0;
      index < catalogRows;
      index += 1
    ) {
      catalogSheet.addRow({
        company:
          companies[index]?.name ?? '',
        osName:
          operatingSystemNames[index] ??
          '',
        osVersion:
          operatingSystemVersions[index] ??
          '',
      });
    }

    catalogSheet.getRow(1).font = {
      bold: true,
    };

    if (companies.length > 0) {
      workbook.definedNames.add(
        `Catalogos!$A$2:$A$${
          companies.length + 1
        }`,
        'EmpresasAccesibles',
      );
    }

    if (
      operatingSystemNames.length > 0
    ) {
      workbook.definedNames.add(
        `Catalogos!$B$2:$B$${
          operatingSystemNames.length + 1
        }`,
        'SistemasOperativos',
      );
    }

    if (
      operatingSystemVersions.length > 0
    ) {
      workbook.definedNames.add(
        `Catalogos!$C$2:$C$${
          operatingSystemVersions.length + 1
        }`,
        'VersionesSistemaOperativo',
      );
    }

    for (
      let rowNumber = 2;
      rowNumber <= MAX_ROWS + 1;
      rowNumber += 1
    ) {
      if (companies.length > 0) {
        sheet.getCell(
          `B${rowNumber}`,
        ).dataValidation = {
          type: 'list',
          allowBlank: false,
          formulae: [
            'EmpresasAccesibles',
          ],
          showInputMessage: true,
          promptTitle:
            'Seleccione una empresa',
          prompt:
            'Use la flecha de la celda para elegir una empresa dentro de su alcance de acceso.',
          showErrorMessage: true,
          errorTitle:
            'Empresa no permitida',
          error:
            'Seleccione una empresa incluida en su alcance de acceso.',
        };
      }

      sheet.getCell(
        `C${rowNumber}`,
      ).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [
          '"PRD,QAS,DEV"',
        ],
        showInputMessage: true,
        promptTitle:
          'Seleccione ambiente',
        prompt:
          'Use la lista desplegable: PRD, QAS o DEV.',
      };

      if (
        operatingSystemNames.length > 0
      ) {
        sheet.getCell(
          `E${rowNumber}`,
        ).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [
            'SistemasOperativos',
          ],
          showInputMessage: true,
          promptTitle:
            'Seleccione sistema operativo',
          prompt:
            'Use la lista desplegable para seleccionar un sistema operativo activo.',
          showErrorMessage: true,
          errorTitle:
            'Sistema operativo inválido',
          error:
            'Seleccione un sistema operativo activo del catálogo de InfraStock.',
        };
      }

      if (
        operatingSystemVersions.length >
        0
      ) {
        sheet.getCell(
          `F${rowNumber}`,
        ).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [
            'VersionesSistemaOperativo',
          ],
          showInputMessage: true,
          promptTitle:
            'Seleccione versión de SO',
          prompt:
            'Use la lista desplegable y seleccione una versión correspondiente al sistema operativo elegido.',
          showErrorMessage: true,
          errorTitle:
            'Versión de SO inválida',
          error:
            'Seleccione una versión activa del catálogo. InfraStock validará que corresponda al sistema operativo seleccionado.',
        };
      }

      sheet.getCell(
        `J${rowNumber}`,
      ).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [
          '"SI,NO"',
        ],
        showInputMessage: true,
        promptTitle:
          'Seleccione estado',
        prompt:
          'Use la lista desplegable: SI o NO.',
      };
    }

    // La hoja alimenta los desplegables de la plantilla. Se mantiene oculta
    // para no mezclar el catálogo técnico con las filas que el usuario carga.
    catalogSheet.state = 'hidden';

    const instructions =
      workbook.addWorksheet(
        'Instrucciones',
      );

    instructions.columns = [
      {
        key: 'field',
        width: 24,
      },
      {
        key: 'rule',
        width: 88,
      },
    ];

    instructions.addRows([
      ['Campo', 'Regla'],
      ['hostname', 'Obligatorio. Debe ser único. Si ya existe, la vista previa propondrá actualizar o reactivar.'],
      ['empresa', 'Obligatorio. Seleccione una celda de la columna empresa y use la lista desplegable. Contiene todas las empresas activas a las que el usuario que descargó la plantilla tiene acceso. El encabezado no incluye autofiltro para evitar confundirlo con este selector.'],
      ['ambiente', 'PRD, QAS o DEV. Puede quedar vacío.'],
      ['ip', 'IPv4/IPv6 válida. Para IPv4 debe pertenecer a una red activa de InfraStock y no estar reservada ni usada. Un servidor inactivo debe ir sin IP.'],
      ['so_nombre / so_version', 'Ambos vacíos o ambos informados. Los desplegables se generan desde los Sistemas Operativos activos existentes en InfraStock y la vista previa valida que nombre y versión correspondan entre sí.'],
      ['cpu_cores / ram_gb / disco_gb', 'Enteros positivos o vacío.'],
      ['activo', 'SI/NO, TRUE/FALSE, 1/0. Vacío equivale a SI.'],
      ['notas', 'Opcional.'],
      ['software', 'Opcional. Formato: Nombre=Versión;Nombre=Versión. Los nombres deben existir y estar activos en el catálogo.'],
      ['Flujo', 'La carga NO modifica servidores al subir el archivo. Primero se pre-valida, se muestra una vista previa y luego el usuario confirma explícitamente las acciones.'],
      ['Límite', `Máximo ${MAX_ROWS} filas y 5 MB por archivo.`],
    ]);

    instructions.getRow(1).font = {
      bold: true,
    };

    instructions.getColumn('B').alignment = {
      wrapText: true,
      vertical: 'top',
    };

    const buffer =
      await workbook.xlsx.writeBuffer();

    return Buffer.from(buffer);
  }

  async preview(
    file: UploadedImportFile,
    currentUser: CurrentUser,
  ) {
    if (!file) {
      throw new BadRequestException('Debe adjuntar un archivo CSV o XLSX');
    }

    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('El archivo supera el máximo permitido de 5 MB');
    }

    const sourceRows = await this.parseFile(file);

    if (sourceRows.length === 0) {
      throw new BadRequestException('El archivo no contiene filas de servidores');
    }

    if (sourceRows.length > MAX_ROWS) {
      throw new BadRequestException(`El archivo supera el máximo de ${MAX_ROWS} filas`);
    }

    const previewRows = await this.validateRows(sourceRows, currentUser);
    const validRows = previewRows.filter((row) => row.validationStatus === 'VALID').length;
    const errorRows = previewRows.length - validRows;

    const batchId = await this.prisma.$transaction(
      async (tx) => {
        const batch = await tx.serverImportBatch.create({
          data: {
            fileName: file.originalname,
            status: 'PREVIEWED',
            totalRows: previewRows.length,
            validRows,
            errorRows,
            userId: currentUser.sub,
          },
          select: { id: true },
        });

        await tx.serverImportRow.createMany({
          data: previewRows.map((row) => ({
            batchId: batch.id,
            rowNumber: row.rowNumber,
            rawData: row.rawData as Prisma.InputJsonValue,
            normalizedData: row.normalizedData === null
              ? Prisma.DbNull
              : row.normalizedData as unknown as Prisma.InputJsonValue,
            suggestedAction: row.suggestedAction,
            validationStatus: row.validationStatus,
            errors: row.errors as Prisma.InputJsonValue,
            warnings: row.warnings as Prisma.InputJsonValue,
          })),
        });

        return batch.id;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.getBatch(batchId, currentUser);
  }

  async confirm(
    batchId: number,
    decisions: ConfirmDecision[],
    currentUser: CurrentUser,
  ) {
    if (decisions.length > MAX_ROWS) {
      throw new BadRequestException(`No se permiten más de ${MAX_ROWS} decisiones por confirmación`);
    }

    const decisionMap = new Map<number, ServerImportAction>();
    for (const decision of decisions) {
      if (!Number.isInteger(decision.rowId) || decision.rowId <= 0) {
        throw new BadRequestException('rowId de importación inválido');
      }
      if (decisionMap.has(decision.rowId)) {
        throw new BadRequestException(`La fila ${decision.rowId} tiene decisiones duplicadas`);
      }
      decisionMap.set(decision.rowId, decision.action);
    }

    const processingTimeoutMinutes = this.getProcessingTimeoutMinutes();
    const now = new Date();
    const staleBefore = new Date(now.getTime() - processingTimeoutMinutes * 60_000);

    const claimedBatch = await this.prisma.$transaction(
      async (tx) => {
        const batch = await tx.serverImportBatch.findUnique({
          where: { id: batchId },
        });

        if (!batch) {
          throw new NotFoundException('Carga masiva no encontrada');
        }

        if (currentUser.role !== Role.ADMIN && batch.userId !== currentUser.sub) {
          throw new ForbiddenException('No tienes acceso a esta carga masiva');
        }

        const isPreviewed = batch.status === 'PREVIEWED';
        const isRecoverableProcessing =
          batch.status === 'PROCESSING' &&
          (batch.processingStartedAt === null || batch.processingStartedAt <= staleBefore);

        if (!isPreviewed && !isRecoverableProcessing) {
          throw new ConflictException(
            batch.status === 'PROCESSING'
              ? `La carga continúa en procesamiento. Puede recuperarse si supera ${processingTimeoutMinutes} minutos sin finalizar`
              : 'La carga ya fue confirmada o no se encuentra disponible para confirmar',
          );
        }

        const rows = await tx.serverImportRow.findMany({
          where: { batchId },
          orderBy: { rowNumber: 'asc' },
        });
        const rowById = new Map(rows.map((row) => [row.id, row]));

        for (const [rowId, action] of decisionMap) {
          const row = rowById.get(rowId);
          if (!row) {
            throw new BadRequestException(`La fila ${rowId} no pertenece a la carga #${batchId}`);
          }
          if (this.isFinalRowResult(row.resultStatus)) {
            continue;
          }
          this.assertDecisionCompatible(
            row.suggestedAction as ServerImportAction,
            action,
            row.validationStatus,
          );
        }

        const claimWhere: Prisma.ServerImportBatchWhereInput = isPreviewed
          ? { id: batchId, status: 'PREVIEWED' }
          : {
              id: batchId,
              status: 'PROCESSING',
              OR: [
                { processingStartedAt: null },
                { processingStartedAt: { lte: staleBefore } },
              ],
            };

        const claimed = await tx.serverImportBatch.updateMany({
          where: claimWhere,
          data: {
            status: 'PROCESSING',
            processingStartedAt: now,
            completedAt: null,
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('La carga fue tomada por otra confirmación simultánea');
        }

        return { batch, rows, recovered: isRecoverableProcessing };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const { batch, rows, recovered } = claimedBatch;
    if (recovered) {
      this.logger.warn(`Recuperando carga masiva #${batchId} abandonada en PROCESSING`);
    }

    let createdCount = 0;
    let updatedCount = 0;
    let reactivatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const row of rows) {
      if (this.isFinalRowResult(row.resultStatus)) {
        if (row.resultStatus === 'SKIPPED') {
          skippedCount += 1;
        } else if (row.resultStatus === 'FAILED') {
          failedCount += 1;
        } else if (row.resultStatus === 'SUCCESS') {
          if (row.selectedAction === 'CREATE') createdCount += 1;
          if (row.selectedAction === 'UPDATE') updatedCount += 1;
          if (row.selectedAction === 'REACTIVATE') reactivatedCount += 1;
        }
        continue;
      }

      const action = decisionMap.get(row.id) ?? (row.suggestedAction as ServerImportAction);

      if (row.validationStatus !== 'VALID' || action === 'SKIP') {
        skippedCount += 1;
        await this.prisma.serverImportRow.update({
          where: { id: row.id },
          data: {
            selectedAction: 'SKIP',
            resultStatus: 'SKIPPED',
            resultMessage: row.validationStatus === 'VALID'
              ? 'Fila omitida por el usuario'
              : 'Fila omitida por errores de validación',
          },
        });
        continue;
      }

      const normalized = row.normalizedData as unknown as NormalizedImportRow | null;
      if (!normalized) {
        failedCount += 1;
        await this.markRowFailed(row.id, action, 'No existe información normalizada para procesar la fila');
        continue;
      }

      try {
        const revalidated = await this.revalidateStoredRow(row, currentUser);
        this.assertDecisionCompatible(revalidated.suggestedAction, action, revalidated.validationStatus);
        if (revalidated.validationStatus !== 'VALID' || !revalidated.normalizedData) {
          throw new ConflictException(
            `La fila cambió desde la prevalidación: ${revalidated.errors.join('; ') || 'vuelva a prevalidar el archivo'}`,
          );
        }

        const result = await this.executeRow(revalidated.normalizedData, action, currentUser);

        if (action === 'CREATE') createdCount += 1;
        if (action === 'UPDATE') updatedCount += 1;
        if (action === 'REACTIVATE') reactivatedCount += 1;

        await this.prisma.serverImportRow.update({
          where: { id: row.id },
          data: {
            selectedAction: action,
            resultStatus: 'SUCCESS',
            resultMessage: this.getSuccessMessage(action),
            serverId: result.id,
          },
        });
      } catch (error) {
        failedCount += 1;
        await this.markRowFailed(row.id, action, this.getErrorMessage(error, batchId, row.id));
      }
    }

    const processedCount = createdCount + updatedCount + reactivatedCount;
    const status = failedCount === 0 ? 'COMPLETED' : processedCount > 0 ? 'PARTIAL' : 'FAILED';

    await this.prisma.$transaction(
      async (tx) => {
        const finished = await tx.serverImportBatch.updateMany({
          where: { id: batchId, status: 'PROCESSING', processingStartedAt: now },
          data: {
            status,
            createdCount,
            updatedCount,
            reactivatedCount,
            skippedCount,
            failedCount,
            processingStartedAt: null,
            completedAt: new Date(),
          },
        });
        if (finished.count !== 1) {
          throw new ConflictException('El estado de la carga cambió mientras se procesaba');
        }

        await tx.auditLog.create({
          data: {
            action: 'IMPORT',
            entityType: 'SERVER_IMPORT_BATCH',
            entityId: batchId,
            entityName: batch.fileName,
            userId: currentUser.sub,
            companyId: currentUser.companyId,
            details: {
              message: recovered
                ? `Carga masiva recuperada y finalizada como ${status.toLowerCase()}`
                : `Carga masiva ${status.toLowerCase()}`,
              totalRows: rows.length,
              createdCount,
              updatedCount,
              reactivatedCount,
              skippedCount,
              failedCount,
              recovered,
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.getBatch(batchId, currentUser);
  }

  async getHistory(currentUser: CurrentUser) {
    return this.prisma.serverImportBatch.findMany({
      where: currentUser.role === Role.ADMIN ? {} : { userId: currentUser.sub },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async getBatch(batchId: number, currentUser: CurrentUser) {
    await this.getOwnedBatch(batchId, currentUser);

    return this.prisma.serverImportBatch.findUnique({
      where: { id: batchId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            name: true,
          },
        },
        rows: {
          orderBy: { rowNumber: 'asc' },
        },
      },
    });
  }

  private async getOwnedBatch(batchId: number, currentUser: CurrentUser) {
    const batch = await this.prisma.serverImportBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      throw new NotFoundException('Carga masiva no encontrada');
    }

    if (currentUser.role !== Role.ADMIN && batch.userId !== currentUser.sub) {
      throw new ForbiddenException('No tienes acceso a esta carga masiva');
    }

    return batch;
  }

  private assertDecisionCompatible(
    suggestedAction: ServerImportAction,
    selectedAction: ServerImportAction,
    validationStatus: string,
  ) {
    if (selectedAction === 'SKIP') return;
    if (validationStatus !== 'VALID') {
      throw new BadRequestException('Una fila con errores solo puede omitirse');
    }
    if (selectedAction !== suggestedAction) {
      throw new BadRequestException(
        `La acción ${selectedAction} no es compatible con la acción sugerida ${suggestedAction}. Vuelva a prevalidar el archivo`,
      );
    }
  }

  private async revalidateStoredRow(
    row: { rowNumber: number; rawData: Prisma.JsonValue },
    currentUser: CurrentUser,
  ): Promise<PreviewRow> {
    if (!row.rawData || typeof row.rawData !== 'object' || Array.isArray(row.rawData)) {
      throw new ConflictException('Los datos originales de la fila no están disponibles para revalidación');
    }

    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.rawData)) {
      values[key] = typeof value === 'string' ? value : String(value ?? '');
    }

    const [revalidated] = await this.validateRows(
      [{ rowNumber: row.rowNumber, values }],
      currentUser,
    );
    if (!revalidated) {
      throw new ConflictException('No fue posible revalidar la fila');
    }
    return revalidated;
  }

  private async parseFile(file: UploadedImportFile): Promise<ParsedSourceRow[]> {
    const extension = file.originalname.toLowerCase().split('.').pop();

    if (extension === 'xlsx') {
      return this.parseXlsx(file.buffer);
    }

    if (extension === 'csv') {
      return this.parseCsv(file.buffer.toString('utf8'));
    }

    throw new BadRequestException('Formato no soportado. Utiliza CSV o XLSX');
  }

  private async parseXlsx(buffer: Buffer): Promise<ParsedSourceRow[]> {
    this.assertSafeXlsxZip(buffer);

    const workbook = new ExcelJS.Workbook();
    const excelBytes = new Uint8Array(buffer.byteLength);
    excelBytes.set(buffer);
    await workbook.xlsx.load(excelBytes.buffer);

    const sheet = workbook.getWorksheet('Servidores') ?? workbook.worksheets[0];
    if (!sheet) {
      throw new BadRequestException('El archivo XLSX no contiene hojas');
    }

    const headerRow = sheet.getRow(1);
    const headers = this.validateAndNormalizeHeaders(
      Array.from({ length: headerRow.cellCount }, (_, index) => headerRow.getCell(index + 1).text),
    );

    const rows: ParsedSourceRow[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const values: Record<string, string> = {};
      headers.forEach((header, index) => {
        values[header] = row.getCell(index + 1).text.trim();
      });

      if (Object.values(values).every((value) => value === '')) return;
      rows.push({ rowNumber, values });
    });

    return rows;
  }

  private assertSafeXlsxZip(buffer: Buffer): void {
    if (buffer.length < 22) {
      throw new BadRequestException('El archivo XLSX no contiene una estructura ZIP válida');
    }

    const eocdOffset = this.findZipEocdOffset(buffer);
    if (eocdOffset < 0) {
      throw new BadRequestException('El archivo XLSX no contiene una estructura ZIP válida');
    }

    if (eocdOffset >= 20 && buffer.readUInt32LE(eocdOffset - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw new BadRequestException('El archivo XLSX utiliza ZIP64, formato no permitido para cargas masivas');
    }

    const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
    const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
    const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

    if (
      diskNumber !== 0 ||
      centralDirectoryDisk !== 0 ||
      entriesOnDisk !== totalEntries
    ) {
      throw new BadRequestException('El archivo XLSX multipart no está permitido');
    }

    if (
      totalEntries === ZIP64_SENTINEL_16 ||
      centralDirectorySize === ZIP64_SENTINEL_32 ||
      centralDirectoryOffset === ZIP64_SENTINEL_32
    ) {
      throw new BadRequestException('El archivo XLSX utiliza ZIP64, formato no permitido para cargas masivas');
    }

    if (totalEntries === 0) {
      throw new BadRequestException('El archivo XLSX está vacío');
    }

    if (totalEntries > MAX_XLSX_ZIP_ENTRIES) {
      throw new BadRequestException(
        `El archivo XLSX contiene demasiados elementos internos. Máximo permitido: ${MAX_XLSX_ZIP_ENTRIES}`,
      );
    }

    const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
    if (
      centralDirectoryOffset < 0 ||
      centralDirectorySize < 0 ||
      centralDirectoryEnd > buffer.length ||
      centralDirectoryEnd > eocdOffset
    ) {
      throw new BadRequestException('El archivo XLSX contiene un directorio ZIP inválido');
    }

    const entries = this.readXlsxZipEntries(
      buffer,
      centralDirectoryOffset,
      centralDirectoryEnd,
      totalEntries,
    );

    let totalUncompressedBytes = 0;
    let hasWorkbookDescriptor = false;
    let hasContentTypes = false;

    for (const entry of entries) {
      const normalizedName = entry.fileName.replace(/\\/g, '/');
      const lowerName = normalizedName.toLowerCase();

      if (
        normalizedName.includes('\0') ||
        normalizedName.startsWith('/') ||
        /^[A-Za-z]:\//.test(normalizedName) ||
        normalizedName.split('/').some((part) => part === '..')
      ) {
        throw new BadRequestException('El archivo XLSX contiene rutas internas no permitidas');
      }

      // Bit 0 = encrypted. Bit 6 = strong encryption.
      if ((entry.generalPurposeFlags & 0x0001) !== 0 || (entry.generalPurposeFlags & 0x0040) !== 0) {
        throw new BadRequestException('El archivo XLSX no puede contener elementos cifrados');
      }

      // Standard XLSX packages should only require STORE or DEFLATE.
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        throw new BadRequestException('El archivo XLSX utiliza un método de compresión no permitido');
      }

      if (entry.uncompressedSize > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES) {
        throw new BadRequestException(
          `El archivo XLSX contiene un elemento interno que supera ${this.formatBytes(MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES)}`,
        );
      }

      totalUncompressedBytes += entry.uncompressedSize;
      if (totalUncompressedBytes > MAX_XLSX_UNCOMPRESSED_BYTES) {
        throw new BadRequestException(
          `El contenido descomprimido del XLSX supera ${this.formatBytes(MAX_XLSX_UNCOMPRESSED_BYTES)}`,
        );
      }

      if (entry.uncompressedSize > 0 && entry.compressedSize === 0) {
        throw new BadRequestException('El archivo XLSX presenta una relación de compresión inválida');
      }

      if (entry.compressedSize > 0) {
        const compressionRatio = entry.uncompressedSize / entry.compressedSize;
        if (compressionRatio > MAX_XLSX_COMPRESSION_RATIO) {
          throw new BadRequestException(
            `El archivo XLSX presenta una relación de compresión sospechosa superior a ${MAX_XLSX_COMPRESSION_RATIO}:1`,
          );
        }
      }

      if (lowerName === 'xl/workbook.xml') hasWorkbookDescriptor = true;
      if (lowerName === '[content_types].xml') hasContentTypes = true;
    }

    if (!hasWorkbookDescriptor || !hasContentTypes) {
      throw new BadRequestException('El archivo no contiene una estructura XLSX válida');
    }
  }

  private findZipEocdOffset(buffer: Buffer): number {
    // EOCD is at least 22 bytes and the ZIP comment can be at most 65535 bytes.
    const minimumOffset = Math.max(0, buffer.length - 22 - 0xffff);
    for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
      if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;

      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) {
        return offset;
      }
    }
    return -1;
  }

  private readXlsxZipEntries(
    buffer: Buffer,
    startOffset: number,
    endOffset: number,
    expectedEntries: number,
  ): XlsxZipEntry[] {
    const entries: XlsxZipEntry[] = [];
    let offset = startOffset;

    while (offset < endOffset) {
      if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
        throw new BadRequestException('El archivo XLSX contiene entradas ZIP inválidas');
      }

      const generalPurposeFlags = buffer.readUInt16LE(offset + 8);
      const compressionMethod = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const uncompressedSize = buffer.readUInt32LE(offset + 24);
      const fileNameLength = buffer.readUInt16LE(offset + 28);
      const extraFieldLength = buffer.readUInt16LE(offset + 30);
      const fileCommentLength = buffer.readUInt16LE(offset + 32);
      const localHeaderOffset = buffer.readUInt32LE(offset + 42);

      if (
        compressedSize === ZIP64_SENTINEL_32 ||
        uncompressedSize === ZIP64_SENTINEL_32 ||
        localHeaderOffset === ZIP64_SENTINEL_32
      ) {
        throw new BadRequestException('El archivo XLSX utiliza ZIP64, formato no permitido para cargas masivas');
      }

      const entryEnd = offset + 46 + fileNameLength + extraFieldLength + fileCommentLength;
      if (entryEnd > endOffset) {
        throw new BadRequestException('El archivo XLSX contiene una entrada ZIP truncada');
      }

      if (localHeaderOffset >= startOffset || localHeaderOffset >= buffer.length) {
        throw new BadRequestException('El archivo XLSX contiene referencias ZIP inválidas');
      }

      const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
      entries.push({
        fileName,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        generalPurposeFlags,
      });

      if (entries.length > MAX_XLSX_ZIP_ENTRIES) {
        throw new BadRequestException(
          `El archivo XLSX contiene demasiados elementos internos. Máximo permitido: ${MAX_XLSX_ZIP_ENTRIES}`,
        );
      }

      offset = entryEnd;
    }

    if (offset !== endOffset || entries.length !== expectedEntries) {
      throw new BadRequestException('El archivo XLSX contiene un directorio ZIP inconsistente');
    }

    return entries;
  }

  private formatBytes(bytes: number): string {
    if (bytes % (1024 * 1024) === 0) {
      return `${bytes / (1024 * 1024)} MB`;
    }
    if (bytes % 1024 === 0) {
      return `${bytes / 1024} KB`;
    }
    return `${bytes} bytes`;
  }

  private parseCsv(text: string): ParsedSourceRow[] {
    const matrix = this.parseCsvMatrix(text.replace(/^\uFEFF/, ''));
    if (matrix.length === 0) return [];

    const headers = this.validateAndNormalizeHeaders(matrix[0]);
    return matrix.slice(1).map((row, index) => {
      const values: Record<string, string> = {};
      headers.forEach((header, columnIndex) => {
        values[header] = (row[columnIndex] ?? '').trim();
      });
      return { rowNumber: index + 2, values };
    }).filter((row) => Object.values(row.values).some((value) => value !== ''));
  }

  private parseCsvMatrix(text: string): string[][] {
    const delimiter = this.detectCsvDelimiter(text);
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentValue = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (char === '"') {
        if (quoted && next === '"') {
          currentValue += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
        continue;
      }

      if (char === delimiter && !quoted) {
        currentRow.push(currentValue);
        currentValue = '';
        continue;
      }

      if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && next === '\n') index += 1;
        currentRow.push(currentValue);
        if (currentRow.some((value) => value.trim() !== '')) rows.push(currentRow);
        currentRow = [];
        currentValue = '';
        continue;
      }

      currentValue += char;
    }

    currentRow.push(currentValue);
    if (currentRow.some((value) => value.trim() !== '')) rows.push(currentRow);
    return rows;
  }

  private detectCsvDelimiter(text: string): ',' | ';' {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const commas = (firstLine.match(/,/g) ?? []).length;
    const semicolons = (firstLine.match(/;/g) ?? []).length;
    return semicolons > commas ? ';' : ',';
  }

  private validateAndNormalizeHeaders(headers: string[]): string[] {
    const normalized = headers.map((header) => this.normalizeHeader(header));
    const allowedHeaders = new Set<string>(REQUIRED_HEADERS);

    const emptyHeaderPositions = normalized
      .map((header, index) => ({ header, position: index + 1 }))
      .filter(({ header }) => header === '')
      .map(({ position }) => position);

    if (emptyHeaderPositions.length > 0) {
      throw new BadRequestException(
        `Existen columnas sin nombre en las posiciones: ${emptyHeaderPositions.join(', ')}`,
      );
    }

    const duplicates = Array.from(
      new Set(
        normalized.filter((header, index) => normalized.indexOf(header) !== index),
      ),
    );

    if (duplicates.length > 0) {
      throw new BadRequestException(`Existen columnas duplicadas: ${duplicates.join(', ')}`);
    }

    const unknown = Array.from(
      new Set(normalized.filter((header) => !allowedHeaders.has(header))),
    );

    if (unknown.length > 0) {
      throw new BadRequestException(`Existen columnas no permitidas: ${unknown.join(', ')}`);
    }

    const missing = REQUIRED_HEADERS.filter((required) => !normalized.includes(required));

    if (missing.length > 0) {
      throw new BadRequestException(`Faltan columnas obligatorias: ${missing.join(', ')}`);
    }

    return normalized;
  }

  private normalizeHeader(value: string): string {
    return value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_');
  }

  private async validateRows(sourceRows: ParsedSourceRow[], currentUser: CurrentUser): Promise<PreviewRow[]> {
    const [companies, operatingSystems, softwareCatalog, networks, reservations, servers] = await Promise.all([
      getAccessibleCompanies(this.prisma, currentUser),
      this.prisma.operatingSystem.findMany({ where: { active: true } }),
      this.prisma.software.findMany({ where: { active: true } }),
      this.prisma.network.findMany({ where: { active: true } }),
      this.prisma.ipReservation.findMany({ where: { active: true }, select: { ipAddress: true, description: true } }),
      this.prisma.server.findMany({ select: { id: true, hostname: true, ipAddress: true, active: true, companyId: true } }),
    ]);

    const companyMap = new Map<string, (typeof companies)[number]>();
    companies.forEach((company) => {
      companyMap.set(company.name.trim().toLowerCase(), company);
      companyMap.set(company.slug.trim().toLowerCase(), company);
    });

    const osMap = new Map<string, (typeof operatingSystems)[number]>();
    operatingSystems.forEach((os) => osMap.set(`${os.name.trim().toLowerCase()}|${os.version.trim().toLowerCase()}`, os));

    const softwareMap = new Map<string, (typeof softwareCatalog)[number]>();
    softwareCatalog.forEach((software) => softwareMap.set(software.name.trim().toLowerCase(), software));

    const reservationMap = new Map(reservations.map((item) => [item.ipAddress, item]));
    const serverByHostname = new Map(servers.map((server) => [server.hostname.trim().toLowerCase(), server]));
    const serverByIp = new Map(servers.filter((server) => server.ipAddress).map((server) => [server.ipAddress as string, server]));

    const fileHostnameCount = new Map<string, number>();
    const fileIpCount = new Map<string, number>();
    sourceRows.forEach((row) => {
      const hostname = row.values.hostname?.trim().toLowerCase();
      if (hostname) fileHostnameCount.set(hostname, (fileHostnameCount.get(hostname) ?? 0) + 1);
      const ip = row.values.ip?.trim();
      if (ip) fileIpCount.set(ip, (fileIpCount.get(ip) ?? 0) + 1);
    });

    return sourceRows.map((sourceRow) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const values = sourceRow.values;
      const hostname = values.hostname?.trim() ?? '';

      if (!hostname) errors.push('hostname es obligatorio');
      if (hostname && (fileHostnameCount.get(hostname.toLowerCase()) ?? 0) > 1) errors.push('hostname duplicado dentro del archivo');

      const company = companyMap.get((values.empresa ?? '').trim().toLowerCase());
      if (!values.empresa?.trim()) errors.push('empresa es obligatoria');
      else if (!company) errors.push('empresa inexistente, inactiva o fuera del alcance del usuario');

      const environmentText = (values.ambiente ?? '').trim().toUpperCase();
      const environment = environmentText === '' ? null : environmentText as 'PRD' | 'QAS' | 'DEV';
      if (environment && !['PRD', 'QAS', 'DEV'].includes(environment)) errors.push('ambiente debe ser PRD, QAS o DEV');

      const ipAddress = values.ip?.trim() || null;
      if (ipAddress && isIP(ipAddress) === 0) errors.push('IP inválida');
      if (ipAddress && (fileIpCount.get(ipAddress) ?? 0) > 1) errors.push('IP duplicada dentro del archivo');

      const active = this.parseBoolean(values.activo, errors);
      if (!active && ipAddress) errors.push('un servidor inactivo no puede conservar una IP');

      const existingServer = hostname ? serverByHostname.get(hostname.toLowerCase()) ?? null : null;
      const accessibleCompanyIds = new Set(companies.map((item) => item.id));
      if (existingServer?.companyId && currentUser.role !== Role.ADMIN && !accessibleCompanyIds.has(existingServer.companyId)) {
        errors.push('el hostname ya existe en una empresa fuera del alcance del usuario');
      }

      if (ipAddress && isIP(ipAddress) === 4) {
        const network = networks.find((item) => isUsableIpv4InCidr(ipAddress, item.cidr));
        if (!network) errors.push('la IPv4 no pertenece al rango utilizable de una red activa');
      }

      if (ipAddress) {
        const reservation = reservationMap.get(ipAddress);
        if (reservation) {
          errors.push(
            currentUser.role === Role.ADMIN && reservation.description
              ? `IP reservada: ${reservation.description}`
              : 'IP reservada',
          );
        }

        const ipOwner = serverByIp.get(ipAddress);
        if (ipOwner && ipOwner.id !== existingServer?.id) {
          const canSeeIpOwner =
            currentUser.role === Role.ADMIN ||
            (typeof ipOwner.companyId === 'number' && accessibleCompanyIds.has(ipOwner.companyId));

          if (canSeeIpOwner) {
            errors.push(
              ipOwner.active
                ? `IP usada por ${ipOwner.hostname}`
                : `IP vinculada históricamente al servidor inactivo ${ipOwner.hostname}`,
            );
          } else {
            errors.push(
              ipOwner.active
                ? 'IP usada por un servidor fuera del alcance del usuario'
                : 'IP vinculada históricamente a un servidor fuera del alcance del usuario',
            );
          }
        }
      }

      const osName = values.so_nombre?.trim() ?? '';
      const osVersion = values.so_version?.trim() ?? '';
      let operatingSystemId: number | null = null;
      let operatingSystemLabel: string | null = null;
      if ((osName && !osVersion) || (!osName && osVersion)) {
        errors.push('so_nombre y so_version deben informarse juntos');
      } else if (osName && osVersion) {
        const os = osMap.get(`${osName.toLowerCase()}|${osVersion.toLowerCase()}`);
        if (!os) errors.push('sistema operativo no encontrado o inactivo');
        else {
          operatingSystemId = os.id;
          operatingSystemLabel = `${os.name} ${os.version}`;
        }
      }

      const cpuCores = this.parsePositiveInteger(values.cpu_cores, 'cpu_cores', errors);
      const ramGb = this.parsePositiveInteger(values.ram_gb, 'ram_gb', errors);
      const diskGb = this.parsePositiveInteger(values.disco_gb, 'disco_gb', errors);
      const software = this.parseSoftware(values.software, softwareMap, errors);

      if (existingServer) {
        warnings.push(existingServer.active ? 'hostname existente: se propone UPDATE' : active ? 'hostname inactivo: se propone REACTIVATE' : 'hostname inactivo: se propone UPDATE');
      }

      const normalizedData: NormalizedImportRow | null = company && hostname ? {
        hostname,
        companyId: company.id,
        companyName: company.name,
        environment,
        ipAddress,
        operatingSystemId,
        operatingSystemLabel,
        cpuCores,
        ramGb,
        diskGb,
        active,
        notes: values.notas?.trim() || null,
        software,
        existingServerId: existingServer?.id ?? null,
        existingServerActive: existingServer?.active ?? null,
      } : null;

      let suggestedAction: ServerImportAction = 'SKIP';
      if (errors.length === 0 && normalizedData) {
        if (!existingServer) suggestedAction = 'CREATE';
        else if (!existingServer.active && active) suggestedAction = 'REACTIVATE';
        else suggestedAction = 'UPDATE';
      }

      return {
        rowNumber: sourceRow.rowNumber,
        rawData: values,
        normalizedData,
        suggestedAction,
        validationStatus: errors.length === 0 ? 'VALID' : 'ERROR',
        errors,
        warnings,
      };
    });
  }

  private parseBoolean(value: string | undefined, errors: string[]): boolean {
    const normalized = (value ?? '').trim().toLowerCase();
    if (normalized === '') return true;
    if (['si', 'sí', 'true', '1', 'activo'].includes(normalized)) return true;
    if (['no', 'false', '0', 'inactivo'].includes(normalized)) return false;
    errors.push('activo debe ser SI/NO, TRUE/FALSE o 1/0');
    return true;
  }

  private parsePositiveInteger(value: string | undefined, field: string, errors: string[]): number | null {
    const normalized = (value ?? '').trim();
    if (!normalized) return null;
    const numberValue = Number(normalized);
    if (!Number.isInteger(numberValue) || numberValue <= 0) {
      errors.push(`${field} debe ser un entero positivo`);
      return null;
    }
    return numberValue;
  }

  private parseSoftware(
    value: string | undefined,
    softwareMap: Map<string, { id: number; name: string }>,
    errors: string[],
  ): ImportSoftwareItem[] {
    const normalized = (value ?? '').trim();
    if (!normalized) return [];

    const result: ImportSoftwareItem[] = [];
    const seen = new Set<number>();

    for (const token of normalized.split(';').map((item) => item.trim()).filter(Boolean)) {
      const separator = token.indexOf('=');
      if (separator <= 0 || separator === token.length - 1) {
        errors.push(`software inválido "${token}". Utiliza Nombre=Versión`);
        continue;
      }

      const name = token.slice(0, separator).trim();
      const version = token.slice(separator + 1).trim();
      const catalogItem = softwareMap.get(name.toLowerCase());

      if (!catalogItem) {
        errors.push(`software no encontrado o inactivo: ${name}`);
        continue;
      }

      if (seen.has(catalogItem.id)) {
        errors.push(`software duplicado en la fila: ${catalogItem.name}`);
        continue;
      }

      seen.add(catalogItem.id);
      result.push({ softwareId: catalogItem.id, name: catalogItem.name, version });
    }

    return result;
  }

  private async executeRow(
    row: NormalizedImportRow,
    action: ServerImportAction,
    currentUser: CurrentUser,
  ) {
    const payload = {
      hostname: row.hostname,
      ipAddress: row.ipAddress,
      environment: row.environment ?? undefined,
      cpuCores: row.cpuCores,
      ramGb: row.ramGb,
      diskGb: row.diskGb,
      notes: row.notes ?? undefined,
      companyId: row.companyId,
      operatingSystemId: row.operatingSystemId,
      software: row.software.map((item) => ({ softwareId: item.softwareId, version: item.version })),
    };

    if (action === 'CREATE') {
      return this.serversService.create(
        {
          hostname: row.hostname,
          ipAddress: row.ipAddress ?? undefined,
          environment: row.environment ?? undefined,
          cpuCores: row.cpuCores ?? undefined,
          ramGb: row.ramGb ?? undefined,
          diskGb: row.diskGb ?? undefined,
          notes: row.notes ?? undefined,
          active: row.active,
          companyId: row.companyId,
          operatingSystemId: row.operatingSystemId ?? undefined,
          software: row.software.map((item) => ({
            softwareId: item.softwareId,
            version: item.version,
          })),
        },
        currentUser,
      );
    }

    if (!row.existingServerId) {
      throw new ConflictException('La fila no corresponde a un servidor existente');
    }

    if (action === 'REACTIVATE') {
      return this.serversService.updateWithStateTransitionForImport(
        row.existingServerId,
        payload,
        true,
        currentUser,
      );
    }

    if (action === 'UPDATE') {
      const current = await this.serversService.findOne(row.existingServerId, currentUser);

      if (!current.active && row.active) {
        throw new ConflictException('El servidor está inactivo. Seleccione REACTIVATE o vuelva a prevalidar');
      }

      if (current.active && !row.active) {
        return this.serversService.updateWithStateTransitionForImport(
          row.existingServerId,
          payload,
          false,
          currentUser,
        );
      }

      return this.serversService.update(row.existingServerId, payload, currentUser);
    }

    throw new BadRequestException('Acción de importación no soportada');
  }

  private async markRowFailed(rowId: number, action: ServerImportAction, message: string) {
    await this.prisma.serverImportRow.update({
      where: { id: rowId },
      data: {
        selectedAction: action,
        resultStatus: 'FAILED',
        resultMessage: message,
      },
    });
  }

  private getSuccessMessage(action: ServerImportAction): string {
    if (action === 'CREATE') return 'Servidor creado';
    if (action === 'REACTIVATE') return 'Servidor reactivado y actualizado';
    if (action === 'UPDATE') return 'Servidor actualizado';
    return 'Fila omitida';
  }

  private getProcessingTimeoutMinutes(): number {
    const raw = Number(process.env.SERVER_IMPORT_PROCESSING_TIMEOUT_MINUTES ?? DEFAULT_PROCESSING_TIMEOUT_MINUTES);
    if (!Number.isFinite(raw) || raw <= 0) {
      return DEFAULT_PROCESSING_TIMEOUT_MINUTES;
    }
    return Math.min(Math.floor(raw), MAX_PROCESSING_TIMEOUT_MINUTES);
  }

  private isFinalRowResult(resultStatus: string | null): boolean {
    return resultStatus === 'SUCCESS' || resultStatus === 'SKIPPED' || resultStatus === 'FAILED';
  }

  private getErrorMessage(error: unknown, batchId: number, rowId: number): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'string' && response.trim()) {
        return response;
      }
      if (response && typeof response === 'object' && 'message' in response) {
        const message = (response as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return message;
        }
        if (Array.isArray(message)) {
          const safeMessages = message.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
          if (safeMessages.length > 0) {
            return safeMessages.join('; ');
          }
        }
      }
      return error.message || 'No fue posible procesar la fila';
    }

    const technicalMessage = error instanceof Error ? error.message : String(error);
    const technicalStack = error instanceof Error ? error.stack : undefined;
    this.logger.error(
      `Error inesperado en carga masiva #${batchId}, fila ${rowId}: ${technicalMessage}`,
      technicalStack,
    );
    return 'Error interno al procesar la fila';
  }
}
