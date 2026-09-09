import {
  CredentialAccountType,
  CredentialCategory,
  CredentialScope,
} from '@prisma/client';

import {
  Transform,
  Type,
} from 'class-transformer';

import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import {
  CredentialLifecycleStatus,
} from '../credential-lifecycle-status.js';

export class CredentialQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  companyId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  environment?: string;

  @IsOptional()
  @IsEnum(CredentialCategory)
  category?: CredentialCategory;

  @IsOptional()
  @IsEnum(CredentialAccountType)
  accountType?: CredentialAccountType;

  @IsOptional()
  @IsEnum(CredentialScope)
  scope?: CredentialScope;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true') {
      return true;
    }

    if (value === false || value === 'false') {
      return false;
    }

    return value;
  })
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsEnum(CredentialLifecycleStatus)
  lifecycleStatus?: CredentialLifecycleStatus;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  search?: string;
}
