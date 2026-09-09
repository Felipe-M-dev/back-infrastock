import {
  IsIP,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateIpReservationDto {
  @IsIP('4')
  ipAddress!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
