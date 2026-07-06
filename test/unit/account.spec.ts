import { describe, expect, it } from 'vitest';
import { aggregateBalances, computeBalance } from '../../src/domain/account.js';
import { Amount } from '../../src/domain/amount.js';
import { AccountType } from '../../src/domain/types.js';

/**
 * Ports the Ruby `spec/support/account_shared_examples.rb` behaviour:
 * for each subtype, a debit should push the balance in the direction of the
 * normal balance, and a credit the opposite; contra inverts both.
 */
function subtypeBalanceCases(type: AccountType, normalBalance: 'debit' | 'credit') {
  const debitSign = normalBalance === 'debit' ? 1 : -1;
  const creditSign = normalBalance === 'credit' ? 1 : -1;

  it(`debit increases balance for ${type}`, () => {
    const bal = computeBalance(type, false, Amount.zero(), Amount.fromMajor(100));
    expect(bal.signed()).toBe(BigInt(debitSign) * 10000n);
  });

  it(`credit increases balance for ${type}`, () => {
    const bal = computeBalance(type, false, Amount.fromMajor(100), Amount.zero());
    expect(bal.signed()).toBe(BigInt(creditSign) * 10000n);
  });

  it(`contra inverts the debit effect for ${type}`, () => {
    const bal = computeBalance(type, true, Amount.zero(), Amount.fromMajor(100));
    expect(bal.signed()).toBe(BigInt(-debitSign) * 10000n);
  });

  it(`contra inverts the credit effect for ${type}`, () => {
    const bal = computeBalance(type, true, Amount.fromMajor(100), Amount.zero());
    expect(bal.signed()).toBe(BigInt(-creditSign) * 10000n);
  });
}

describe('computeBalance', () => {
  describe('Asset (normal debit)', () => subtypeBalanceCases(AccountType.Asset, 'debit'));
  describe('Expense (normal debit)', () => subtypeBalanceCases(AccountType.Expense, 'debit'));
  describe('Liability (normal credit)', () => subtypeBalanceCases(AccountType.Liability, 'credit'));
  describe('Equity (normal credit)', () => subtypeBalanceCases(AccountType.Equity, 'credit'));
  describe('Revenue (normal credit)', () => subtypeBalanceCases(AccountType.Revenue, 'credit'));
});

describe('aggregateBalances', () => {
  it('sums non-contra accounts of the type', () => {
    const accounts = [
      { type: AccountType.Asset, contra: false, balance: Amount.fromMajor(100) },
      { type: AccountType.Asset, contra: false, balance: Amount.fromMajor(50) },
      { type: AccountType.Liability, contra: false, balance: Amount.fromMajor(999) },
    ];
    expect(aggregateBalances(accounts, AccountType.Asset).toJSON()).toBe('15000');
  });

  it('subtracts contra accounts', () => {
    const accounts = [
      { type: AccountType.Asset, contra: false, balance: Amount.fromMajor(100) },
      { type: AccountType.Asset, contra: true, balance: Amount.fromMajor(30) },
    ];
    expect(aggregateBalances(accounts, AccountType.Asset).toJSON()).toBe('7000');
  });

  it('returns zero when no accounts of the type', () => {
    expect(aggregateBalances([], AccountType.Asset).isZero()).toBe(true);
  });
});
