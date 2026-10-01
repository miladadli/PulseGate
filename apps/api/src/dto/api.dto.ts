import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TopUpBodyDto {
  @ApiProperty({ example: 5000, description: 'Credits to add (integer, > 0)' })
  amount!: number;
}

export class WalletBalanceResponseDto {
  @ApiProperty({ example: '11111111-1111-1111-1111-111111111111' })
  userId!: string;

  @ApiProperty({ example: '5000', description: 'Postgres SoR balance' })
  balance!: string;

  @ApiProperty({ example: '1000', description: 'Currently leased to Redis' })
  leasedOut!: string;

  @ApiProperty({ example: '4000' })
  availableToLease!: string;

  @ApiProperty({ example: '999', description: 'Hot residual in Redis' })
  redisResidual!: string;

  @ApiProperty({
    example: '4999',
    description: 'availableToLease + redisResidual',
  })
  spendable!: string;
}

export class SendSmsBodyDto {
  @ApiProperty({ example: '11111111-1111-1111-1111-111111111111' })
  userId!: string;

  @ApiProperty({ example: '+989121111111' })
  to!: string;

  @ApiProperty({ example: 'Your OTP is 123456' })
  body!: string;

  @ApiPropertyOptional({ enum: ['express', 'normal'], example: 'express' })
  priority?: 'express' | 'normal';
}

export class SendSmsResponseDto {
  @ApiProperty({ example: '9d96a40f-e56b-58a8-a9a5-112aa0948493' })
  messageId!: string;

  @ApiProperty({ example: 'accepted' })
  status!: 'accepted';

  @ApiProperty({ example: 'sms.express' })
  topic!: string;

  @ApiProperty({
    example: false,
    description: 'true when Idempotency-Key replayed a DONE accept',
  })
  replay!: boolean;
}

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok' | 'degraded';

  @ApiProperty({ example: true })
  postgres!: boolean;
}

export class ErrorResponseDto {
  @ApiProperty({ example: 402 })
  statusCode!: number;

  @ApiProperty({ example: 'INSUFFICIENT_CREDIT' })
  code!: string;

  @ApiProperty({ example: 'Insufficient credit' })
  message!: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Present on Kafka ingest failures',
  })
  ambiguous?: boolean;
}

export class SmsReportItemDto {
  @ApiProperty({ example: '9d96a40f-e56b-58a8-a9a5-112aa0948493' })
  messageId!: string;

  @ApiProperty({ example: '11111111-1111-1111-1111-111111111111' })
  userId!: string;

  @ApiProperty({ example: '+989121111111' })
  to!: string;

  @ApiProperty({ example: 'Your OTP is 123456' })
  body!: string;

  @ApiProperty({ example: 'express' })
  priority!: string;

  @ApiProperty({ example: 'delivered' })
  status!: string;

  @ApiProperty({ example: '2026-09-28T19:00:00.000Z' })
  acceptedAt!: string;

  @ApiProperty({ example: '2026-09-28T19:00:00.050Z' })
  updatedAt!: string;

  @ApiPropertyOptional({ example: '2026-09-28T19:00:00.040Z', nullable: true })
  deliveredAt!: string | null;

  @ApiPropertyOptional({ example: 33, nullable: true })
  latencyMs!: number | null;
}
