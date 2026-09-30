import { DomainError } from './errors';

export class PayloadMismatchError extends DomainError {
  constructor(message = 'Idempotency-Key reused with different payload') {
    super(message, 'PAYLOAD_MISMATCH');
  }
}

export class IngestFailedError extends DomainError {
  constructor(
    message = 'Failed to ingest message',
    readonly ambiguous = false,
  ) {
    super(message, ambiguous ? 'INGEST_AMBIGUOUS' : 'INGEST_FAILED');
  }
}

export class MissingIdempotencyKeyError extends DomainError {
  constructor() {
    super('Idempotency-Key header is required', 'MISSING_IDEMPOTENCY_KEY');
  }
}

export class RateLimitedError extends DomainError {
  constructor(
    message = 'Admit rate limit exceeded',
    readonly retryAfterSec = 1,
  ) {
    super(message, 'RATE_LIMITED');
  }
}

export class AdmitPausedError extends DomainError {
  constructor(message = 'Admits paused during Redis rebuild') {
    super(message, 'ADMIT_PAUSED');
  }
}

