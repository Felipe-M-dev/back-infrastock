import { isIP } from 'node:net';

export interface ParsedIpv4Cidr {
  cidr: string;
  prefix: number;
  network: number;
  broadcast: number;
  firstUsable: number;
  lastUsable: number;
  totalUsable: number;
}

export function ipv4ToNumber(ipAddress: string): number {
  if (isIP(ipAddress) !== 4) {
    throw new Error('Dirección IPv4 inválida');
  }

  return ipAddress
    .split('.')
    .map(Number)
    .reduce(
      (value, octet) =>
        value * 256 + octet,
      0,
    );
}

export function numberToIpv4(value: number): string {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new Error('Valor IPv4 inválido');
  }

  const octets = [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ];

  return octets.join('.');
}

export function parseIpv4Cidr(cidr: string): ParsedIpv4Cidr {
  const normalized = cidr.trim();
  const [ipAddress, prefixText, ...extra] = normalized.split('/');

  if (
    extra.length > 0 ||
    !ipAddress ||
    !prefixText ||
    isIP(ipAddress) !== 4
  ) {
    throw new Error('CIDR IPv4 inválido');
  }

  const prefix = Number(prefixText);

  if (
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 30
  ) {
    throw new Error('El prefijo debe estar entre /0 y /30');
  }

  const ipNumber = ipv4ToNumber(ipAddress);
  const blockSize = 2 ** (32 - prefix);
  const network =
    Math.floor(ipNumber / blockSize) * blockSize;
  const broadcast = network + blockSize - 1;
  const firstUsable = network + 1;
  const lastUsable = broadcast - 1;
  const totalUsable = Math.max(0, blockSize - 2);

  return {
    cidr: `${numberToIpv4(network)}/${prefix}`,
    prefix,
    network,
    broadcast,
    firstUsable,
    lastUsable,
    totalUsable,
  };
}

export function isIpv4InCidr(
  ipAddress: string,
  cidr: string,
): boolean {
  if (isIP(ipAddress) !== 4) {
    return false;
  }

  const parsed = parseIpv4Cidr(cidr);
  const value = ipv4ToNumber(ipAddress);

  return (
    value >= parsed.network &&
    value <= parsed.broadcast
  );
}

export function isUsableIpv4InCidr(
  ipAddress: string,
  cidr: string,
): boolean {
  if (isIP(ipAddress) !== 4) {
    return false;
  }

  const parsed = parseIpv4Cidr(cidr);
  const value = ipv4ToNumber(ipAddress);

  return (
    value >= parsed.firstUsable &&
    value <= parsed.lastUsable
  );
}

export function cidrsOverlap(
  leftCidr: string,
  rightCidr: string,
): boolean {
  const left = parseIpv4Cidr(leftCidr);
  const right = parseIpv4Cidr(rightCidr);

  return (
    left.network <= right.broadcast &&
    right.network <= left.broadcast
  );
}
