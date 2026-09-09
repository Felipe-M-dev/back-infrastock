import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/\S/, {
    message:
      'El nombre no puede contener solo espacios',
  })
  name?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ValidateIf(
    (dto: UpdateProfileDto) =>
      dto.password !== undefined,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/\S/, {
    message:
      'La contraseña actual no puede contener solo espacios',
  })
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/\S/, {
    message:
      'La nueva contraseña no puede contener solo espacios',
  })
  password?: string;
}
