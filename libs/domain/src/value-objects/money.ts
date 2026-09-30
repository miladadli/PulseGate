import { InvalidAmountError } from '../errors';

/** Integer credit units (1 SMS = 1 unit). */
export class Money {
  private constructor(readonly amount: bigint) {}

  static of(value: number | bigint | string): Money {
    const amount = typeof value === 'bigint' ? value : BigInt(value);
    if (amount < 0n) {
      throw new InvalidAmountError('Money cannot be negative');
    }
    return new Money(amount);
  }

  static zero(): Money {
    return new Money(0n);
  }

  add(other: Money): Money {
    return new Money(this.amount + other.amount);
  }

  subtract(other: Money): Money {
    if (other.amount > this.amount) {
      throw new InvalidAmountError('Insufficient money for subtract');
    }
    return new Money(this.amount - other.amount);
  }

  isZero(): boolean {
    return this.amount === 0n;
  }

  gte(other: Money): boolean {
    return this.amount >= other.amount;
  }

  toNumber(): number {
    return Number(this.amount);
  }

  toString(): string {
    return this.amount.toString();
  }
}
