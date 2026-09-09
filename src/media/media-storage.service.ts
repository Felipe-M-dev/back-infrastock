import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  rm,
} from 'node:fs/promises';
import {
  extname,
  resolve,
  sep,
} from 'node:path';

import sharp, { type Sharp } from 'sharp';

export interface UploadedMediaFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const LOGO_MAX_BYTES =
  2 * 1024 * 1024;
const AVATAR_MAX_BYTES =
  5 * 1024 * 1024;
const MAX_INPUT_PIXELS =
  25_000_000;

@Injectable()
export class MediaStorageService {
  private readonly root =
    resolve(
      process.env.MEDIA_STORAGE_DIR ??
        './storage/media',
    );

  async saveCompanyLogo(
    file: UploadedMediaFile,
  ): Promise<string> {
    if (
      !file.buffer?.length ||
      file.size <= 0
    ) {
      throw new BadRequestException(
        'El archivo del logo está vacío',
      );
    }

    if (file.size > LOGO_MAX_BYTES) {
      throw new BadRequestException(
        'El logo no puede superar 2 MB',
      );
    }

    const extension =
      extname(file.originalname)
        .toLowerCase();

    const isPng =
      extension === '.png' &&
      file.buffer
        .subarray(0, 8)
        .equals(
          Buffer.from([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
          ]),
        );

    const svgSource =
      file.buffer
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim();

    const isSvg =
      extension === '.svg' &&
      /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(
        svgSource,
      );

    if (!isPng && !isSvg) {
      throw new BadRequestException(
        'El logo debe ser un archivo PNG o SVG válido',
      );
    }

    if (isSvg) {
      this.assertSafeSvg(svgSource);
    }

    const directory =
      resolve(
        this.root,
        'company-logos',
      );

    await mkdir(directory, {
      recursive: true,
    });

    const fileName =
      `${randomUUID()}.png`;
    const destination =
      resolve(
        directory,
        fileName,
      );

    try {
      await sharp(file.buffer, {
        density: isSvg
          ? 192
          : undefined,
        limitInputPixels:
          MAX_INPUT_PIXELS,
      })
        .resize({
          width: 1200,
          height: 600,
          fit: 'inside',
          withoutEnlargement:
            true,
        })
        .png({
          compressionLevel: 9,
        })
        .toFile(destination);
    } catch {
      await rm(destination, {
        force: true,
      });

      throw new BadRequestException(
        'No fue posible procesar el logo. Verifica que el archivo no esté dañado.',
      );
    }

    return `/uploads/company-logos/${fileName}`;
  }

  async saveAvatar(
    file: UploadedMediaFile,
  ): Promise<string> {
    if (
      !file.buffer?.length ||
      file.size <= 0
    ) {
      throw new BadRequestException(
        'La imagen está vacía',
      );
    }

    if (file.size > AVATAR_MAX_BYTES) {
      throw new BadRequestException(
        'La foto de perfil no puede superar 5 MB',
      );
    }

    let image: Sharp;

    try {
      image = sharp(file.buffer, {
        limitInputPixels:
          MAX_INPUT_PIXELS,
      });

      const metadata =
        await image.metadata();

      if (
        !metadata.format ||
        ![
          'jpeg',
          'png',
          'webp',
        ].includes(
          metadata.format,
        )
      ) {
        throw new Error(
          'unsupported',
        );
      }
    } catch {
      throw new BadRequestException(
        'La foto de perfil debe ser JPG, PNG o WebP válido',
      );
    }

    const directory =
      resolve(
        this.root,
        'avatars',
      );

    await mkdir(directory, {
      recursive: true,
    });

    const fileName =
      `${randomUUID()}.webp`;
    const destination =
      resolve(
        directory,
        fileName,
      );

    try {
      await sharp(file.buffer, {
        limitInputPixels:
          MAX_INPUT_PIXELS,
      })
        .rotate()
        .resize(512, 512, {
          fit: 'cover',
          position: 'centre',
        })
        .webp({
          quality: 82,
        })
        .toFile(destination);
    } catch {
      await rm(destination, {
        force: true,
      });

      throw new BadRequestException(
        'No fue posible procesar la foto de perfil',
      );
    }

    return `/uploads/avatars/${fileName}`;
  }

  async deleteManaged(
    publicPath:
      | string
      | null
      | undefined,
  ) {
    if (!publicPath) {
      return;
    }

    const companyLogoMatch =
      publicPath.match(
        /^\/uploads\/company-logos\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png)$/i,
      );

    const avatarMatch =
      publicPath.match(
        /^\/uploads\/avatars\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp)$/i,
      );

    const match =
      companyLogoMatch ??
      avatarMatch;

    if (!match) {
      return;
    }

    const directoryName =
      companyLogoMatch
        ? 'company-logos'
        : 'avatars';

    const directory =
      resolve(
        this.root,
        directoryName,
      );

    const target =
      resolve(
        directory,
        match[1],
      );

    if (
      !target.startsWith(
        `${directory}${sep}`,
      )
    ) {
      return;
    }

    await rm(target, {
      force: true,
    });
  }

  private assertSafeSvg(
    source: string,
  ) {
    const prohibited = [
      /<!DOCTYPE/i,
      /<!ENTITY/i,
      /<script\b/i,
      /<foreignObject\b/i,
      /\bon[a-z]+\s*=/i,
      /javascript\s*:/i,
      /data\s*:\s*text\/html/i,
      /<image\b/i,
      /(?:href|xlink:href)\s*=\s*["']\s*(?!#)[^"']+/i,
      /url\(\s*(?!#)/i,
    ];

    if (
      prohibited.some(
        (pattern) =>
          pattern.test(source),
      )
    ) {
      throw new BadRequestException(
        'El SVG contiene elementos o referencias no permitidas',
      );
    }
  }
}
