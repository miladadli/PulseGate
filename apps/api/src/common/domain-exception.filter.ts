import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import {
  DomainError,
  IngestFailedError,
  InsufficientCreditError,
  InvalidAmountError,
  MissingIdempotencyKeyError,
  AdmitPausedError,
  PayloadMismatchError,
  RateLimitedError,
  ValidationError,
  WalletNotFoundError,
} from '@pulsegate/domain';

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.BAD_REQUEST;

    if (exception instanceof WalletNotFoundError) {
      status = HttpStatus.NOT_FOUND;
    } else if (exception instanceof InsufficientCreditError) {
      status = HttpStatus.PAYMENT_REQUIRED;
    } else if (exception instanceof RateLimitedError) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      res.setHeader('Retry-After', String(exception.retryAfterSec));
    } else if (exception instanceof AdmitPausedError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
    } else if (
      exception instanceof InvalidAmountError ||
      exception instanceof MissingIdempotencyKeyError ||
      exception instanceof ValidationError
    ) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
    } else if (exception instanceof PayloadMismatchError) {
      status = HttpStatus.CONFLICT;
    } else if (exception instanceof IngestFailedError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
    }

    res.status(status).json({
      statusCode: status,
      code: exception.code,
      message: exception.message,
      ambiguous:
        exception instanceof IngestFailedError ? exception.ambiguous : undefined,
      retryAfterSec:
        exception instanceof RateLimitedError
          ? exception.retryAfterSec
          : undefined,
    });
  }
}
