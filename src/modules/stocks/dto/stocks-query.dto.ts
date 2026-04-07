import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsNumber, Min } from 'class-validator';

export class StocksQueryDto {
  @IsOptional() @IsString() search?: string;

  @IsOptional() @Transform(({ value }) => parseFloat(value)) @IsNumber() minPE?: number;
  @IsOptional() @Transform(({ value }) => parseFloat(value)) @IsNumber() maxPE?: number;
  @IsOptional() @Transform(({ value }) => parseInt(value, 10)) @IsNumber() @Min(1) page?: number = 1;
  @IsOptional() @Transform(({ value }) => parseInt(value, 10)) @IsNumber() @Min(1) limit?: number = 20;
}
