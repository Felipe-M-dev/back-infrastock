import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Matches(/\S/, {
    message:
      'El usuario no puede contener solo espacios',
  })
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/\S/, {
    message:
      'La contraseña no puede contener solo espacios',
  })
  password: string;
}
