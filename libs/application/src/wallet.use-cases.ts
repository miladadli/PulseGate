import {
  CreditStore,
  LeaseGrantService,
  Money,
  WalletNotFoundError,
  WalletRepository,
} from '@pulsegate/domain';
import { WalletBalanceDto } from '@pulsegate/contracts';

async function buildBalanceDto(
  wallets: WalletRepository,
  credits: CreditStore,
  userId: string,
): Promise<WalletBalanceDto> {
  const wallet = await wallets.findByUserId(userId);
  if (!wallet) {
    throw new WalletNotFoundError(userId);
  }
  const redisResidual = Money.of(await credits.getResidual(userId));
  return {
    userId,
    balance: wallet.getBalance().toString(),
    leasedOut: wallet.getLeasedOut().toString(),
    availableToLease: wallet.availableToLease().toString(),
    redisResidual: redisResidual.toString(),
    spendable: wallet.spendable(redisResidual).toString(),
  };
}

export class TopUpWalletUseCase {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly credits: CreditStore,
    private readonly leases: LeaseGrantService,
  ) {}

  async execute(input: {
    userId: string;
    amount: number;
    refId?: string;
  }): Promise<WalletBalanceDto> {
    await this.wallets.topUp(input.userId, Money.of(input.amount), input.refId);
    await this.leases.refillIfNeeded(input.userId);
    return buildBalanceDto(this.wallets, this.credits, input.userId);
  }
}

export class GetWalletUseCase {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly credits: CreditStore,
  ) {}

  execute(userId: string): Promise<WalletBalanceDto> {
    return buildBalanceDto(this.wallets, this.credits, userId);
  }
}
