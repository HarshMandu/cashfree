import {
  IsEmail,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Min,
} from "class-validator";

export class CreatePaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount!: number;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9]{3,50}$/)
  @MaxLength(50)
  customerId!: string;

  @IsPhoneNumber()
  customerPhone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  studentId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  erpReferenceId!: string;

  @IsOptional()
  @IsEmail()
  customerEmail?: string;
}
