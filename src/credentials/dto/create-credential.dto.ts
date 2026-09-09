import {
  CredentialAccountType,
  CredentialCategory,
  CredentialScope,
} from '@prisma/client';

import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCredentialDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(180)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  password!: string;

  @IsEnum(CredentialCategory)
  category!: CredentialCategory;

  @IsEnum(CredentialAccountType)
  accountType!: CredentialAccountType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  environment?: string;

  @IsEnum(CredentialScope)
  scope!: CredentialScope;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  companyId?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @IsDateString()
  lastRotatedAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  rotationDays?: number | null;

  @IsOptional()
  @IsBoolean()
  rotationRequired?: boolean;
}
