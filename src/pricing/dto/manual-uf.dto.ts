import {
  IsDateString,
  IsNumber,
  IsPositive,
  Matches,
} from 'class-validator';

export class ManualUfDto {
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'La fecha UF debe tener formato YYYY-MM-DD',
  })
  date!: string;

  @IsNumber({
    maxDecimalPlaces: 4,
  })
  @IsPositive()
  value!: number;
}
