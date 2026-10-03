import Redis from 'ioredis';
import {
  AdmitResult,
  CreditStore,
} from '@pulsegate/domain';
import {
  ADMIT_SMS_LUA,
  COMMIT_SMS_LUA,
  GRANT_LEASE_CREDIT_LUA,
  REFUND_SMS_LUA,
} from './lua-scripts';

type MessageCache = {
  status: string;
  userId: string;
  messageId: string;
  acceptedAt: string;
  to: string;
  body: string;
  priority: string;
};

export class RedisCreditStore implements CreditStore {
  constructor(private readonly redis: Redis) {}

  private walletKey(userId: string): string {
    return `wallet:${userId}:balance`;
  }

  async getResidual(userId: string): Promise<bigint> {
    const v = await this.redis.get(this.walletKey(userId));
    return BigInt(v ?? '0');
  }

  async grantLeaseCredit(
    grantId: string,
    userId: string,
    amount: bigint,
  ): Promise<'applied' | 'already_applied'> {
    const result = (await this.redis.eval(
      GRANT_LEASE_CREDIT_LUA,
      2,
      this.walletKey(userId),
      `lease:applied:${grantId}`,
      amount.toString(),
    )) as number;
    return result === 1 ? 'applied' : 'already_applied';
  }

  async admitSms(input: {
    userId: string;
    idempotencyKey: string;
    messageId: string;
    payloadHash: string;
    cost: bigint;
    reservationTtlSec: number;
  }): Promise<AdmitResult> {
    const reservationId = crypto.randomUUID();
    const nowMs = Date.now();
    const deadline = nowMs + input.reservationTtlSec * 1000;
    const idemTtl = Math.max(input.reservationTtlSec * 2, 120);

    const raw = (await this.redis.eval(
      ADMIT_SMS_LUA,
      4,
      `idem:${input.userId}:${input.idempotencyKey}`,
      this.walletKey(input.userId),
      'reservations:deadlines',
      `reservation:${reservationId}`,
      input.messageId,
      input.payloadHash,
      input.cost.toString(),
      reservationId,
      String(deadline),
      String(idemTtl),
      input.userId,
      input.idempotencyKey,
    )) as string[];

    if (raw[0] === 'err') {
      if (raw[1] === 'insufficient') return { status: 'insufficient' };
      if (raw[1] === 'payload_mismatch') return { status: 'payload_mismatch' };
      throw new Error(`admitSms lua error: ${raw[1] ?? 'unknown'}`);
    }

    return {
      status: 'ok',
      messageId: raw[1],
      reservationId: raw[2],
      replay: raw[3] === '1',
      alreadyCommitted: raw[4] === '1',
    };
  }

  async commit(input: {
    userId: string;
    idempotencyKey: string;
    reservationId: string;
    messageId: string;
    to?: string;
    body?: string;
    priority?: string;
    acceptedAt?: string;
  }): Promise<void> {
    await this.redis.eval(
      COMMIT_SMS_LUA,
      3,
      `idem:${input.userId}:${input.idempotencyKey}`,
      'reservations:deadlines',
      `reservation:${input.reservationId}`,
      input.reservationId,
    );
    await this.redis.set(
      `seen:${input.messageId}`,
      '1',
      'EX',
      3600,
    );
    const prev = await this.getMessageCache(input.messageId);
    await this.redis.set(
      `msg:${input.messageId}`,
      JSON.stringify({
        status: 'accepted',
        userId: input.userId,
        messageId: input.messageId,
        acceptedAt: input.acceptedAt ?? prev?.acceptedAt ?? new Date().toISOString(),
        to: input.to ?? prev?.to ?? '',
        body: input.body ?? prev?.body ?? '',
        priority: input.priority ?? prev?.priority ?? '',
      }),
      'EX',
      3600,
    );
  }

  async refund(input: {
    userId: string;
    idempotencyKey: string;
    reservationId: string;
    cost: bigint;
  }): Promise<'refunded' | 'noop'> {
    const result = (await this.redis.eval(
      REFUND_SMS_LUA,
      4,
      `idem:${input.userId}:${input.idempotencyKey}`,
      this.walletKey(input.userId),
      'reservations:deadlines',
      `reservation:${input.reservationId}`,
      input.reservationId,
      input.cost.toString(),
    )) as number;
    return result === 1 ? 'refunded' : 'noop';
  }

  async getMessageCache(messageId: string): Promise<MessageCache | null> {
    const raw = await this.redis.get(`msg:${messageId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MessageCache> & {
      status: string;
      userId: string;
      messageId: string;
      acceptedAt: string;
    };
    return {
      status: parsed.status,
      userId: parsed.userId,
      messageId: parsed.messageId,
      acceptedAt: parsed.acceptedAt,
      to: parsed.to ?? '',
      body: parsed.body ?? '',
      priority: parsed.priority ?? '',
    };
  }

  async setResidual(userId: string, amount: bigint): Promise<void> {
    if (amount < 0n) {
      throw new Error('residual cannot be negative');
    }
    await this.redis.set(this.walletKey(userId), amount.toString());
  }

  async isAdmitPaused(): Promise<boolean> {
    return (await this.redis.get('admit:paused')) === '1';
  }

  async setAdmitPaused(paused: boolean): Promise<void> {
    if (paused) {
      await this.redis.set('admit:paused', '1');
    } else {
      await this.redis.del('admit:paused');
    }
  }
}
