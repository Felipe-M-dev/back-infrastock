import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  SOFTWARE_CATEGORIES,
  type SoftwareCategory,
} from './create-software.dto.js';

export class UpdateSoftwareDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/\S/, {
    message:
      'El nombre debe contener al menos un carácter que no sea un espacio',
  })
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(SOFTWARE_CATEGORIES)
  category?: SoftwareCategory;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
