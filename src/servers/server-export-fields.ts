export const SERVER_EXPORT_FIELDS = [
  'hostname',
  'company',
  'ipAddress',
  'environment',
  'operatingSystem',
  'cpuCores',
  'ramGb',
  'diskGb',
  'software',
  'active',
  'notes',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
] as const;

export type ServerExportField =
  (
    typeof SERVER_EXPORT_FIELDS
  )[number];

export const DEFAULT_SERVER_EXPORT_FIELDS:
  ServerExportField[] = [
    ...SERVER_EXPORT_FIELDS,
  ];