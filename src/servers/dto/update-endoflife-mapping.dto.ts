import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateEndOfLifeMappingDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    {
      message:
        'El identificador EOL solo puede contener letras, números, punto, guion y guion bajo',
    },
  )
  productKey?: string | null;
}
