import { Wallet } from './wallet';
import { Money } from './value-objects/money';
import { InsufficientCreditError, InvalidAmountError } from './errors';

function wallet(balance: number, leasedOut = 0, version = 1): Wallet {
  return Wallet.rehydrate({
    userId: '11111111-1111-1111-1111-111111111111',
    balance: Money.of(balance),
    leasedOut: Money.of(leasedOut),
    version,
  });
}

describe('Wallet', () => {
  it('computes availableToLease and spendable', () => {
    const w = wallet(5000, 1000);
    expect(w.availableToLease().toString()).toBe('4000');
    expect(w.spendable(Money.of(900)).toString()).toBe('4900');
  });

  it('applies top-up', () => {
    const w = wallet(100);
    w.applyTopUp(Money.of(50));
    expect(w.getBalance().toString()).toBe('150');
    expect(w.getVersion()).toBe(2);
  });

  it('grants lease capped by available', () => {
    const w = wallet(100, 80);
    const granted = w.grantLease(Money.of(50));
    expect(granted.toString()).toBe('20');
    expect(w.getLeasedOut().toString()).toBe('100');
  });

  it('rejects grant when nothing available', () => {
    const w = wallet(100, 100);
    expect(() => w.grantLease(Money.of(1))).toThrow(InsufficientCreditError);
  });

  it('settles consumption from balance and leased_out', () => {
    const w = wallet(5000, 1000);
    w.settleConsumption(Money.of(3));
    expect(w.getBalance().toString()).toBe('4997');
    expect(w.getLeasedOut().toString()).toBe('997');
  });

  it('rejects settle beyond leased_out', () => {
    const w = wallet(100, 5);
    expect(() => w.settleConsumption(Money.of(6))).toThrow(InvalidAmountError);
  });

  it('applies post-settle refund to balance only', () => {
    const w = wallet(100, 40);
    w.applyPostSettleRefund(Money.of(1));
    expect(w.getBalance().toString()).toBe('101');
    expect(w.getLeasedOut().toString()).toBe('40');
  });
});
