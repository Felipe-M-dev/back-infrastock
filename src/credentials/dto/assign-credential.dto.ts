import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class AssignCredentialDto {
  @IsInt()
  @Min(1)
  credentialId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(250)
  purpose?: string;
}
