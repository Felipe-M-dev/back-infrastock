import {
  IsBoolean,
  IsHexColor,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  @Matches(/\S/, {
    message:
      'El nombre debe contener al menos un carácter que no sea un espacio',
  })
  @MaxLength(120)
  name: string;

  @IsString()
  @Matches(/\S/, {
    message:
      'El slug debe contener al menos un carácter que no sea un espacio',
  })
  @MaxLength(80)
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  logoUrl?: string;

  @IsOptional()
  @IsHexColor()
  primaryColor?: string;

  @IsOptional()
  @IsHexColor()
  secondaryColor?: string;

  @IsOptional()
  @IsHexColor()
  backgroundColor?: string;

  @IsOptional()
  @IsHexColor()
  surfaceColor?: string;

  @IsOptional()
  @IsHexColor()
  textColor?: string;

  @IsOptional()
  @IsHexColor()
  logoBackgroundColor?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
