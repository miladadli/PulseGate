import {
  CreditStore,
  LeaseGrantService,
  Money,
  Wallet,
  WalletRepository,
} from '@pulsegate/domain';
import { TopUpWalletUseCase, GetWalletUseCase } from './wallet.use-cases';

describe('wallet use-cases', () => {
  const userId = '11111111-1111-1111-1111-111111111111';

  function walletRepo(balance = 5000n, leased = 1000n): jest.Mocked<WalletRepository> {
    const w = Wallet.rehydrate({
      userId,
      balance: Money.of(balance),
      leasedOut: Money.of(leased),
      version: 1,
    });
    return {
      findByUserId: jest.fn().mockResolvedValue(w),
      save: jest.fn(),
      appendLedger: jest.fn(),
      insertPendingLease: jest.fn(),
      markLeaseApplied: jest.fn(),
      listPendingLeases: jest.fn(),
      topUp: jest.fn().mockImplementation(async () => {
        w.applyTopUp(Money.of(100));
        return w;
      }),
      openLeaseGrant: jest.fn(),
      settleAcceptedBatch: jest.fn(),
      applyPostSettleRefund: jest.fn(),
      isMessageSettled: jest.fn(),
      listAllWallets: jest.fn().mockResolvedValue([]),
    };
  }

  it('TopUp then triggers lease refill', async () => {
    const wallets = walletRepo();
    const credits: jest.Mocked<CreditStore> = {
      getResidual: jest.fn().mockResolvedValue(900n),
      grantLeaseCredit: jest.fn(),
      admitSms: jest.fn(),
      commit: jest.fn(),
      refund: jest.fn(),
      getMessageCache: jest.fn(),
      setResidual: jest.fn(),
      isAdmitPaused: jest.fn().mockResolvedValue(false),
      setAdmitPaused: jest.fn(),
    };
    const leases: jest.Mocked<LeaseGrantService> = {
      grant: jest.fn(),
      refillIfNeeded: jest.fn().mockResolvedValue(100n),
    };

    const uc = new TopUpWalletUseCase(wallets, credits, leases);
    const dto = await uc.execute({ userId, amount: 100 });

    expect(wallets.topUp).toHaveBeenCalled();
    expect(leases.refillIfNeeded).toHaveBeenCalledWith(userId);
    expect(dto.userId).toBe(userId);
    expect(dto.redisResidual).toBe('900');
  });

  it('GetWallet maps spendable fields', async () => {
    const wallets = walletRepo(5000n, 1000n);
    const credits: jest.Mocked<CreditStore> = {
      getResidual: jest.fn().mockResolvedValue(800n),
      grantLeaseCredit: jest.fn(),
      admitSms: jest.fn(),
      commit: jest.fn(),
      refund: jest.fn(),
      getMessageCache: jest.fn(),
      setResidual: jest.fn(),
      isAdmitPaused: jest.fn().mockResolvedValue(false),
      setAdmitPaused: jest.fn(),
    };
    const uc = new GetWalletUseCase(wallets, credits);
    const dto = await uc.execute(userId);
    expect(dto.balance).toBe('5000');
    expect(dto.leasedOut).toBe('1000');
    expect(dto.availableToLease).toBe('4000');
    expect(dto.redisResidual).toBe('800');
    expect(dto.spendable).toBe('4800');
  });
});
