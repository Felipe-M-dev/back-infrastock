import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { Role } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  username: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/\S/, {
    message:
      'La contraseña debe contener al menos un carácter que no sea un espacio',
  })
  password: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^(?=.*\d)[+\d\s()-]+$/, {
    message:
      'El teléfono solo puede contener números, espacios, +, paréntesis y guiones',
  })
  phone?: string;

  @IsEnum(Role)
  role: Role;

  @IsInt()
  @IsPositive()
  companyId: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
