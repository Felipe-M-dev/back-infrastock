import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

interface AccountIdentity {
  id?: number;
  sub?: number;
  username: string;
  role: Role;
}

// The name belongs permanently to the existing bootstrap account. User APIs
// must not rename/delete it or allow another account to adopt this name.
export function isPersonalVaultSupervisor(user: AccountIdentity): boolean {
  return user.username === 'admin' && user.role === Role.ADMIN;
}

export function assertUsernameNotReserved(username: string): void {
  if (username.trim().toLowerCase() === 'admin') {
    throw new ForbiddenException(
      'El nombre admin está reservado para la cuenta de administración principal',
    );
  }
}

export function assertProtectedAccountUpdate(
  target: AccountIdentity,
  changes: { username?: string; password?: string; role?: Role },
  actor: AccountIdentity,
): void {
  const self = target.id === (actor.sub ?? actor.id);
  if (target.username === 'admin') {
    if (!self) {
      throw new ForbiddenException(
        'Solo la cuenta admin puede modificar su propia cuenta',
      );
    }
    if (
      (changes.username !== undefined && changes.username.trim() !== 'admin') ||
      (changes.role !== undefined && changes.role !== Role.ADMIN)
    ) {
      throw new ForbiddenException(
        'La identidad y el rol de la cuenta admin no pueden modificarse',
      );
    }
  } else if (changes.username !== undefined) {
    assertUsernameNotReserved(changes.username);
  }
  if (changes.password && !self && !isPersonalVaultSupervisor(actor)) {
    throw new ForbiddenException(
      'Solo la cuenta admin puede cambiar la contraseña de acceso de otro usuario',
    );
  }
}
