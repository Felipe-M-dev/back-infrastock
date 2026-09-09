import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

export interface EncryptedCredentialPassword {
  encryptedPassword: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

interface StoredEncryptedCredentialPassword
  extends EncryptedCredentialPassword {}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const REQUIRED_KEY_LENGTH_BYTES = 32;

@Injectable()
export class CredentialCryptoService {
  private readonly currentKeyVersion: number;

  constructor() {
    const rawVersion =
      process.env.CREDENTIAL_KEY_VERSION ??
      '1';

    const parsedVersion =
      Number.parseInt(
        rawVersion,
        10,
      );

    if (
      !Number.isInteger(
        parsedVersion,
      ) ||
      parsedVersion < 1
    ) {
      throw new InternalServerErrorException(
        'CREDENTIAL_KEY_VERSION debe ser un entero mayor o igual a 1',
      );
    }

    this.currentKeyVersion =
      parsedVersion;

    /*
     * Validamos la clave actual al iniciar el servicio.
     * Las claves de versiones anteriores se validan únicamente
     * cuando sea necesario descifrar un registro antiguo.
     */
    this.getKey(
      this.currentKeyVersion,
    );
  }

  encrypt(
    password: string,
  ): EncryptedCredentialPassword {
    const keyVersion =
      this.currentKeyVersion;

    const key =
      this.getKey(
        keyVersion,
      );

    const iv =
      randomBytes(
        IV_LENGTH_BYTES,
      );

    const cipher =
      createCipheriv(
        ALGORITHM,
        key,
        iv,
      );

    const encrypted =
      Buffer.concat([
        cipher.update(
          password,
          'utf8',
        ),
        cipher.final(),
      ]);

    const authTag =
      cipher.getAuthTag();

    return {
      encryptedPassword:
        encrypted.toString(
          'base64',
        ),

      iv:
        iv.toString(
          'base64',
        ),

      authTag:
        authTag.toString(
          'base64',
        ),

      keyVersion,
    };
  }

  decrypt(
    stored:
      StoredEncryptedCredentialPassword,
  ): string {
    try {
      const key =
        this.getKey(
          stored.keyVersion,
        );

      const iv =
        Buffer.from(
          stored.iv,
          'base64',
        );

      const authTag =
        Buffer.from(
          stored.authTag,
          'base64',
        );

      const encrypted =
        Buffer.from(
          stored.encryptedPassword,
          'base64',
        );

      const decipher =
        createDecipheriv(
          ALGORITHM,
          key,
          iv,
        );

      decipher.setAuthTag(
        authTag,
      );

      const decrypted =
        Buffer.concat([
          decipher.update(
            encrypted,
          ),
          decipher.final(),
        ]);

      return decrypted.toString(
        'utf8',
      );
    } catch (error) {
      if (
        error instanceof
        InternalServerErrorException
      ) {
        throw error;
      }

      throw new InternalServerErrorException(
        'No fue posible descifrar la contraseña de la credencial',
      );
    }
  }

  private getKey(
    keyVersion: number,
  ): Buffer {
    /*
     * Convención preparada para rotación:
     *
     * CREDENTIAL_KEY_VERSION=2
     * CREDENTIAL_MASTER_KEY_V1=<clave anterior>
     * CREDENTIAL_MASTER_KEY_V2=<clave actual>
     *
     * Para V1 también aceptamos CREDENTIAL_MASTER_KEY como
     * alias de la clave correspondiente a la versión actual.
     */
    const versionedName =
      `CREDENTIAL_MASTER_KEY_V${keyVersion}`;

    const encodedKey =
      process.env[
        versionedName
      ] ??
      (
        keyVersion ===
        this.currentKeyVersion
          ? process.env
              .CREDENTIAL_MASTER_KEY
          : undefined
      );

    if (!encodedKey) {
      throw new InternalServerErrorException(
        `No está configurada la clave maestra para la versión ${keyVersion}`,
      );
    }

    const normalized =
      encodedKey.trim();

    let key: Buffer;

    try {
      key =
        Buffer.from(
          normalized,
          'base64',
        );
    } catch {
      throw new InternalServerErrorException(
        `La clave maestra de credenciales versión ${keyVersion} no es Base64 válido`,
      );
    }

    if (
      key.length !==
      REQUIRED_KEY_LENGTH_BYTES
    ) {
      throw new InternalServerErrorException(
        `La clave maestra de credenciales versión ${keyVersion} debe contener exactamente 32 bytes`,
      );
    }

    return key;
  }
}
