import {
  IsArray,
  IsBoolean,
  IsInt,
  IsIP,
  IsNotEmpty,
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
  @IsNotEmpty()
  version: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateServerDto {
  @IsString()
  @IsNotEmpty()
  hostname: string;

  @IsOptional()
  @IsIP()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  environment?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  cpuCores?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  ramGb?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  diskGb?: number;

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
  operatingSystemId?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ServerSoftwareDto)
  software?: ServerSoftwareDto[];
}