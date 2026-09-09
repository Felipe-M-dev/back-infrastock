export type ServerInventoryConfidence =
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW';

export interface InventoryConfidenceInput {
  ipAddress:
    string | null;

  operatingSystemId:
    number | null;

  cpuCores:
    number | null;

  ramGb:
    number | null;

  diskGb:
    number | null;

  updatedAt:
    Date;

  softwareCount:
    number;
}

export interface InventoryConfidenceResult {
  score:
    number;

  level:
    ServerInventoryConfidence;

  issueCount:
    number;

  ageDays:
    number;

  completenessPoints:
    number;

  freshnessPoints:
    number;
}

const DAY_MS =
  24 * 60 * 60 * 1000;

export function getInventoryAgeDays(
  updatedAt: Date,
  now: Date = new Date(),
): number {
  return Math.max(
    0,
    Math.floor(
      (
        now.getTime() -
        updatedAt.getTime()
      ) /
        DAY_MS,
    ),
  );
}

export function calculateInventoryConfidence(
  input:
    InventoryConfidenceInput,
  now: Date = new Date(),
): InventoryConfidenceResult {
  let issueCount =
    0;

  if (
    !input.ipAddress
  ) {
    issueCount +=
      1;
  }

  if (
    input.operatingSystemId ===
    null
  ) {
    issueCount +=
      1;
  }

  if (
    input.cpuCores ===
      null ||
    input.ramGb ===
      null ||
    input.diskGb ===
      null
  ) {
    issueCount +=
      1;
  }

  if (
    input.softwareCount ===
    0
  ) {
    issueCount +=
      1;
  }

  const completenessPoints =
    Math.max(
      0,
      60 -
        issueCount *
          15,
    );

  const ageDays =
    getInventoryAgeDays(
      input.updatedAt,
      now,
    );

  let freshnessPoints:
    number;

  if (
    ageDays <
    30
  ) {
    freshnessPoints =
      40;
  } else if (
    ageDays <
    60
  ) {
    freshnessPoints =
      30;
  } else if (
    ageDays <
    90
  ) {
    freshnessPoints =
      15;
  } else {
    freshnessPoints =
      0;
  }

  const score =
    completenessPoints +
    freshnessPoints;

  const level:
    ServerInventoryConfidence =
      score >=
      85
        ? 'HIGH'
        : score >=
            60
          ? 'MEDIUM'
          : 'LOW';

  return {
    score,
    level,
    issueCount,
    ageDays,
    completenessPoints,
    freshnessPoints,
  };
}
