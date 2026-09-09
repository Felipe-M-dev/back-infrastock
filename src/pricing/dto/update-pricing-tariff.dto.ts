import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdatePricingTariffDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/\S/, {
    message: 'El nombre no puede contener solo espacios',
  })
  name?: string;

  @IsOptional()
  @IsNumber({
    maxDecimalPlaces: 6,
  })
  @Min(0)
  value?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceNote?: string;
}
