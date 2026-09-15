import {
  IsIn,
  IsInt,
  IsIP,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export const PROVIDER_QUOTATION_ARCHITECTURES = [
  '32 bits',
  '64 bits',
] as const;

export type ProviderQuotationArchitecture =
  (typeof PROVIDER_QUOTATION_ARCHITECTURES)[number];

export class CreateProviderQuotationDto {
  @IsInt()
  @IsPositive()
  companyId: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reference: string;

  @IsInt()
  @IsPositive()
  operatingSystemId: number;

  @IsString()
  @IsIn(
    PROVIDER_QUOTATION_ARCHITECTURES,
  )
  architecture:
    ProviderQuotationArchitecture;

  @IsOptional()
  @IsInt()
  @IsPositive()
  databaseSoftwareId?: number;

  @IsInt()
  @IsPositive()
  cpuCores: number;

  @IsInt()
  @IsPositive()
  ramGb: number;

  @IsInt()
  @IsPositive()
  diskGb: number;

  @IsInt()
  @IsPositive()
  networkId: number;

  @IsIP(4)
  ipAddress: string;
}
