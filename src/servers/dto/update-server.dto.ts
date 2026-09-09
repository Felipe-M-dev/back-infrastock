import {
  IsArray,
  IsBoolean,
  IsInt,
  IsIP,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

class ServerSoftwareDto {
  @IsInt()
  @IsPositive()
  softwareId: number;

  @IsString()
  version: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateServerDto {
  @IsOptional()
  @IsString()
  hostname?: string;

  @IsOptional()
  @IsIP()
  ipAddress?: string | null;

  @IsOptional()
  @IsString()
  environment?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  cpuCores?: number | null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  ramGb?: number | null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  diskGb?: number | null;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  servicesOnitec?: boolean;

  @IsOptional()
  @IsInt()
  @IsPositive()
  companyId?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  operatingSystemId?: number | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ServerSoftwareDto)
  software?: ServerSoftwareDto[];
}
