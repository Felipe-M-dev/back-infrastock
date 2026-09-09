import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class CreateOperatingSystemDto {
  @IsString()
  @Matches(/\S/, {
    message:
      'El nombre debe contener al menos un carácter que no sea un espacio',
  })
  name!: string;

  @IsString()
  @Matches(/\S/, {
    message:
      'La versión debe contener al menos un carácter que no sea un espacio',
  })
  version!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
