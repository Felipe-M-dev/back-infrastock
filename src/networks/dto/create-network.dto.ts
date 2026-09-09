import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateNetworkDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Matches(/\S/, {
    message:
      'El nombre debe contener al menos un carácter que no sea un espacio',
  })
  name!: string;

  @IsString()
  @MinLength(9)
  @MaxLength(32)
  cidr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
