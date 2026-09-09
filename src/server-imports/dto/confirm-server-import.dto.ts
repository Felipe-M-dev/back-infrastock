import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, Min, ValidateNested } from 'class-validator';

export const SERVER_IMPORT_ACTIONS = ['CREATE', 'UPDATE', 'REACTIVATE', 'SKIP'] as const;
export type ServerImportActionDto = (typeof SERVER_IMPORT_ACTIONS)[number];

export class ConfirmServerImportDecisionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rowId!: number;

  @IsIn(SERVER_IMPORT_ACTIONS)
  action!: ServerImportActionDto;
}

export class ConfirmServerImportDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ConfirmServerImportDecisionDto)
  decisions?: ConfirmServerImportDecisionDto[];
}
