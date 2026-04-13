import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';
import { TransactionType, AssetType } from '@prisma/client';

export class CreateTransactionDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsEnum(TransactionType)
  type: TransactionType;

  @IsOptional()
  @IsEnum(AssetType)
  assetType?: AssetType;

  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  quantity: number;

  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  price: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  fees?: number;

  @IsOptional()
  @IsDateString()
  date?: string;
}
