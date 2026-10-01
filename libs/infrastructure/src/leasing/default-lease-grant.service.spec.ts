import Redis from 'ioredis';
import {
  Money,
  Wallet,
  WalletRepository,
  CreditStore,
} from '@pulsegate/domain';
import { DefaultLeaseGrantService } from './default-lease-grant.service';

describe('DefaultLeaseGrantService refill threshold', () => {
  const userId = '11111111-1111-1111-1111-111111111111';

  it('skips grant when residual above 30% threshold', async () => {
    const wallets = {
      openLeaseGrant: jest.fn(),
      markLeaseApplied: jest.fn(),
    } as unknown as WalletRepository;
    const credits: jest.Mocked<Pick<CreditStore, 'getResidual' | 'grantLeaseCredit'>> =
      {
        getResidual: jest.fn().mockResolvedValue(500n), // > 300
        grantLeaseCredit: jest.fn(),
      };
    const redis = {
      set: jest.fn(),
      del: jest.fn(),
    } as unknown as Redis;

    const svc = new DefaultLeaseGrantService(
      wallets,
      credits as unknown as CreditStore,
      redis,
      { defaultLeaseSize: 1000n, refillThresholdRatio: 0.3 },
    );

    const granted = await svc.refillIfNeeded(userId);
    expect(granted).toBe(0n);
    expect(wallets.openLeaseGrant).not.toHaveBeenCalled();
  });

  it('grants need when residual below threshold (grant-gap path)', async () => {
    const wallets = {
      openLeaseGrant: jest.fn().mockResolvedValue({
        wallet: Wallet.rehydrate({
          userId,
          balance: Money.of(5000),
          leasedOut: Money.of(1000),
          version: 1,
        }),
        granted: Money.of(900),
      }),
      markLeaseApplied: jest.fn(),
    } as unknown as WalletRepository;
    const credits: jest.Mocked<Pick<CreditStore, 'getResidual' | 'grantLeaseCredit'>> =
      {
        getResidual: jest.fn().mockResolvedValue(100n), // < 300
        grantLeaseCredit: jest.fn().mockResolvedValue('applied'),
      };
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    } as unknown as Redis;

    const svc = new DefaultLeaseGrantService(
      wallets,
      credits as unknown as CreditStore,
      redis,
      { defaultLeaseSize: 1000n, refillThresholdRatio: 0.3 },
    );

    const granted = await svc.refillIfNeeded(userId);
    expect(granted).toBe(900n);
    expect(wallets.openLeaseGrant).toHaveBeenCalled();
    expect(credits.grantLeaseCredit).toHaveBeenCalled();
    expect(wallets.markLeaseApplied).toHaveBeenCalled();
  });

  it('single-flight: skips when refill lock not acquired', async () => {
    const wallets = {
      openLeaseGrant: jest.fn(),
    } as unknown as WalletRepository;
    const credits = {
      getResidual: jest.fn().mockResolvedValue(0n),
      grantLeaseCredit: jest.fn(),
    } as unknown as CreditStore;
    const redis = {
      set: jest.fn().mockResolvedValue(null), // lock miss
      del: jest.fn(),
    } as unknown as Redis;

    const svc = new DefaultLeaseGrantService(wallets, credits, redis, {
      defaultLeaseSize: 1000n,
      refillThresholdRatio: 0.3,
    });

    expect(await svc.refillIfNeeded(userId)).toBe(0n);
    expect(wallets.openLeaseGrant).not.toHaveBeenCalled();
  });
});
