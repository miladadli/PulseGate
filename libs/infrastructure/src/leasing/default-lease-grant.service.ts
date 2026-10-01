import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import {
  CreditStore,
  LeaseGrantService,
  Money,
  WALLET_REPOSITORY,
  WalletRepository,
} from '@pulsegate/domain';

export interface LeaseRefillConfig {
  defaultLeaseSize: bigint;
  refillThresholdRatio: number;
  refillLockTtlSec: number;
}

const DEFAULT_CONFIG: LeaseRefillConfig = {
  defaultLeaseSize: 1000n,
  refillThresholdRatio: 0.3,
  refillLockTtlSec: 30,
};

export class DefaultLeaseGrantService implements LeaseGrantService {
  private readonly config: LeaseRefillConfig;

  constructor(
    private readonly wallets: WalletRepository,
    private readonly credits: CreditStore,
    private readonly redis: Redis,
    config?: Partial<LeaseRefillConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async grant(userId: string, requested: bigint): Promise<bigint> {
    const grantId = randomUUID();
    const { granted } = await this.wallets.openLeaseGrant(
      userId,
      Money.of(requested),
      grantId,
    );
    if (granted.isZero()) {
      return 0n;
    }

    await this.credits.grantLeaseCredit(grantId, userId, granted.amount);
    await this.wallets.markLeaseApplied(grantId);
    return granted.amount;
  }

  async refillIfNeeded(userId: string): Promise<bigint> {
    const residual = await this.credits.getResidual(userId);
    const target = this.config.defaultLeaseSize;
    const threshold =
      (target * BigInt(Math.floor(this.config.refillThresholdRatio * 100))) /
      100n;

    if (residual > threshold) {
      return 0n;
    }

    const lockKey = `lease:refill:${userId}`;
    const gotLock = await this.redis.set(
      lockKey,
      '1',
      'EX',
      this.config.refillLockTtlSec,
      'NX',
    );
    if (gotLock !== 'OK') {
      return 0n;
    }

    try {
      const need = target - residual;
      if (need <= 0n) return 0n;
      return await this.grant(userId, need);
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
