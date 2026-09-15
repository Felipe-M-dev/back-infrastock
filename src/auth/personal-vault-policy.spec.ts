import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';
import {
  assertProtectedAccountUpdate,
  assertUsernameNotReserved,
  isPersonalVaultSupervisor,
} from './personal-vault-policy.js';

const principal = { id: 1, username: 'admin', role: Role.ADMIN };
const administrator = { id: 2, username: 'other-admin', role: Role.ADMIN };
const owner = { id: 3, username: 'owner', role: Role.VIEWER };

describe('Personal vault account boundary', () => {
  it('grants supervision only to the exact principal account', () => {
    expect(isPersonalVaultSupervisor(principal)).toBe(true);
    expect(isPersonalVaultSupervisor(administrator)).toBe(false);
    expect(isPersonalVaultSupervisor({ ...principal, username: 'Admin' })).toBe(
      false,
    );
    expect(isPersonalVaultSupervisor({ ...principal, role: Role.VIEWER })).toBe(
      false,
    );
  });

  it.each(['admin', 'Admin', ' ADMIN '])(
    'reserves the principal username: %s',
    (username) => {
      expect(() => assertUsernameNotReserved(username)).toThrow();
      expect(() =>
        assertProtectedAccountUpdate(owner, { username }, administrator),
      ).toThrow();
    },
  );

  it('prevents another administrator from taking over an existing owner account', () => {
    expect(() =>
      assertProtectedAccountUpdate(
        owner,
        { password: 'test-new-password' },
        administrator,
      ),
    ).toThrow();
    expect(() =>
      assertProtectedAccountUpdate(
        owner,
        { password: 'test-new-password' },
        principal,
      ),
    ).not.toThrow();
    expect(() =>
      assertProtectedAccountUpdate(
        owner,
        { password: 'test-new-password' },
        owner,
      ),
    ).not.toThrow();
  });

  it('protects the principal against modification, renaming and demotion', () => {
    expect(() =>
      assertProtectedAccountUpdate(principal, {}, administrator),
    ).toThrow();
    expect(() =>
      assertProtectedAccountUpdate(
        principal,
        { username: 'former-admin' },
        principal,
      ),
    ).toThrow();
    expect(() =>
      assertProtectedAccountUpdate(principal, { role: Role.EDITOR }, principal),
    ).toThrow();
    expect(() =>
      assertProtectedAccountUpdate(
        principal,
        { username: 'admin', role: Role.ADMIN },
        principal,
      ),
    ).not.toThrow();
  });
});
