import { Money } from './value-objects/money';
import { InsufficientCreditError, InvalidAmountError } from './errors';

export type UserId = string;

export interface WalletSnapshot {
  userId: UserId;
  balance: Money;
  leasedOut: Money;
  version: number;
}

export class Wallet {
  private constructor(
    readonly userId: UserId,
    private balance: Money,
    private leasedOut: Money,
    private version: number,
  ) {}

  static rehydrate(snapshot: WalletSnapshot): Wallet {
    return new Wallet(
      snapshot.userId,
      snapshot.balance,
      snapshot.leasedOut,
      snapshot.version,
    );
  }

  getBalance(): Money {
    return this.balance;
  }

  getLeasedOut(): Money {
    return this.leasedOut;
  }

  getVersion(): number {
    return this.version;
  }

  /** Credits still in Postgres not yet leased to Redis. */
  availableToLease(): Money {
    return this.balance.subtract(this.leasedOut);
  }

  /** Spendable ≈ availableToLease + redisResidual (redis passed in by application). */
  spendable(redisResidual: Money): Money {
    return this.availableToLease().add(redisResidual);
  }

  applyTopUp(amount: Money): void {
    if (amount.isZero()) {
      throw new InvalidAmountError('Top-up amount must be > 0');
    }
    this.balance = this.balance.add(amount);
    this.version += 1;
  }

  /**
   * Reserve a lease chunk from available_to_lease into leased_out.
   * Returns the granted amount (may be less than requested near zero).
   */
  grantLease(requested: Money): Money {
    if (requested.isZero()) {
      throw new InvalidAmountError('Lease amount must be > 0');
    }
    const available = this.availableToLease();
    if (available.isZero()) {
      throw new InsufficientCreditError('Nothing available to lease');
    }
    const grant =
      requested.amount <= available.amount
        ? requested
        : Money.of(available.amount);
    this.leasedOut = this.leasedOut.add(grant);
    this.version += 1;
    return grant;
  }

  /** After settle: reduce balance and leased_out by consumed amount. */
  settleConsumption(consumed: Money): void {
    if (consumed.amount > this.leasedOut.amount) {
      throw new InvalidAmountError('Cannot settle more than leased_out');
    }
    if (consumed.amount > this.balance.amount) {
      throw new InvalidAmountError('Cannot settle more than balance');
    }
    this.leasedOut = this.leasedOut.subtract(consumed);
    this.balance = this.balance.subtract(consumed);
    this.version += 1;
  }

  /** Post-settle terminal refund: credit balance only (leased_out unchanged). */
  applyPostSettleRefund(amount: Money): void {
    if (amount.isZero()) {
      throw new InvalidAmountError('Refund amount must be > 0');
    }
    this.balance = this.balance.add(amount);
    this.version += 1;
  }

  toSnapshot(): WalletSnapshot {
    return {
      userId: this.userId,
      balance: this.balance,
      leasedOut: this.leasedOut,
      version: this.version,
    };
  }
}
