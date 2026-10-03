export const CREDIT_STORE = Symbol('CREDIT_STORE');

export type AdmitResult =
  | {
      status: 'ok';
      messageId: string;
      reservationId: string;
      /** true if idem record already existed */
      replay: boolean;
      /** true if already committed (DONE) — skip produce */
      alreadyCommitted: boolean;
    }
  | { status: 'insufficient' }
  | { status: 'payload_mismatch' };

export interface CreditStore {
  getResidual(userId: string): Promise<bigint>;

  /** Idempotent: SETNX lease:applied:{grantId} then INCRBY wallet balance. */
  grantLeaseCredit(
    grantId: string,
    userId: string,
    amount: bigint,
  ): Promise<'applied' | 'already_applied'>;

  admitSms(input: {
    userId: string;
    idempotencyKey: string;
    messageId: string;
    payloadHash: string;
    cost: bigint;
    reservationTtlSec: number;
  }): Promise<AdmitResult>;

  commit(input: {
    userId: string;
    idempotencyKey: string;
    reservationId: string;
    messageId: string;
    /** Stored on msg:{id} for early GET /v1/sms/:id before ClickHouse catches up. */
    to?: string;
    body?: string;
    priority?: string;
    acceptedAt?: string;
  }): Promise<void>;

  refund(input: {
    userId: string;
    idempotencyKey: string;
    reservationId: string;
    cost: bigint;
  }): Promise<'refunded' | 'noop'>;

  getMessageCache(messageId: string): Promise<{
    status: string;
    userId: string;
    messageId: string;
    acceptedAt: string;
    to: string;
    body: string;
    priority: string;
  } | null>;

  /** Absolute set of Redis residual (rebuild / ops). */
  setResidual(userId: string, amount: bigint): Promise<void>;

  isAdmitPaused(): Promise<boolean>;
  setAdmitPaused(paused: boolean): Promise<void>;
}
