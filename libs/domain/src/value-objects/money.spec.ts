import { Money } from './money';
import { InvalidAmountError } from '../errors';

describe('Money', () => {
  it('creates non-negative amounts', () => {
    expect(Money.of(10).toString()).toBe('10');
    expect(Money.of('5').amount).toBe(5n);
    expect(Money.zero().isZero()).toBe(true);
  });

  it('rejects negative', () => {
    expect(() => Money.of(-1)).toThrow(InvalidAmountError);
  });

  it('adds and subtracts', () => {
    const a = Money.of(10);
    const b = Money.of(3);
    expect(a.add(b).toString()).toBe('13');
    expect(a.subtract(b).toString()).toBe('7');
  });

  it('rejects oversubtract', () => {
    expect(() => Money.of(2).subtract(Money.of(3))).toThrow(InvalidAmountError);
  });

  it('compares with gte', () => {
    expect(Money.of(5).gte(Money.of(5))).toBe(true);
    expect(Money.of(4).gte(Money.of(5))).toBe(false);
  });
});
