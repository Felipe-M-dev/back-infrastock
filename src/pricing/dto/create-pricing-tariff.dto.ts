import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePricingTariffDto {
  @IsString()
  @MaxLength(80)
  @Matches(/\S/, {
    message: 'La categoría no puede contener solo espacios',
  })
  category!: string;

  @IsString()
  @MaxLength(120)
  @Matches(/\S/, {
    message: 'El nombre no puede contener solo espacios',
  })
  name!: string;

  @IsString()
  @MaxLength(50)
  @Matches(/\S/, {
    message: 'La unidad no puede contener solo espacios',
  })
  unit!: string;

  @IsNumber({
    maxDecimalPlaces: 6,
  })
  @Min(0)
  value!: number;

  @IsString()
  @IsIn([
    'UF_PER_UNIT',
    'UF_FIXED',
    'PERCENT',
  ])
  valueType!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
