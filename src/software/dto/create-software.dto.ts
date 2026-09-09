import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const SOFTWARE_CATEGORIES = [
  'DATABASE',
  'APP_SERVER',
  'RUNTIME_FRAMEWORK',
  'CONTAINER_ORCHESTRATION',
  'OBSERVABILITY',
  'DEVOPS',
  'MESSAGING_CACHE',
  'OTHER',
] as const;

export type SoftwareCategory =
  (typeof SOFTWARE_CATEGORIES)[number];

export class CreateSoftwareDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/\S/, {
    message:
      'El nombre debe contener al menos un carácter que no sea un espacio',
  })
  name!: string;

  @IsString()
  @IsIn(SOFTWARE_CATEGORIES)
  category!: SoftwareCategory;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
