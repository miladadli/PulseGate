import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { SendSmsUseCase } from '@pulsegate/application';
import {
  MissingIdempotencyKeyError,
  ValidationError,
} from '@pulsegate/domain';
import {
  ErrorResponseDto,
  SendSmsBodyDto,
  SendSmsResponseDto,
} from '../dto/api.dto';

@ApiTags('sms')
@Controller('sms')
export class SmsController {
  constructor(private readonly sendSms: SendSmsUseCase) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Accept SMS (hot path: Lua admit → Kafka → commit)',
    description:
      'No Postgres on the hot path. Requires Idempotency-Key. Returns 202 Accepted.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated key for safe retries',
    example: 'otp-order-42',
  })
  @ApiBody({ type: SendSmsBodyDto })
  @ApiResponse({ status: 202, type: SendSmsResponseDto })
  @ApiResponse({
    status: 402,
    type: ErrorResponseDto,
    description: 'Insufficient credit',
  })
  @ApiResponse({
    status: 429,
    type: ErrorResponseDto,
    description: 'Admit rate limit exceeded (Retry-After header)',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'Payload mismatch',
  })
  @ApiResponse({ status: 422, type: ErrorResponseDto })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: 'Kafka ingest issue',
  })
  async send(
    @Body() body: SendSmsBodyDto,
    @Req() req: Request,
  ): Promise<SendSmsResponseDto> {
    // Read via req so Swagger only shows @ApiHeader (not a second @Headers param).
    const raw = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(raw) ? raw[0] : raw;
    if (!idempotencyKey?.trim()) {
      throw new MissingIdempotencyKeyError();
    }
    if (!body.userId || !body.to || !body.body) {
      throw new ValidationError('userId, to, and body are required');
    }
    const priority = body.priority === 'express' ? 'express' : 'normal';
    return this.sendSms.execute({
      userId: body.userId,
      to: body.to,
      body: body.body,
      priority,
      idempotencyKey: idempotencyKey.trim(),
    });
  }
}
