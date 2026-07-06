import { beforeEach, describe, expect, it } from 'vitest';
import { Account } from '../../src/domain/account.js';
import { Amount } from '../../src/domain/amount.js';
import { ValidationError } from '../../src/domain/errors.js';
import { Ledger } from '../../src/domain/ledger.js';
import { AccountType } from '../../src/domain/types.js';
import { InMemoryRepository } from '../helpers/in-memory-repository.js';

describe('Ledger (in-memory)', () => {
  let ledger: Ledger;

  beforeEach(() => {
    ledger = new Ledger(new InMemoryRepository());
  });

  describe('createAccount', () => {
    it('creates an account', async () => {
      const acc = await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      expect(acc.name).toBe('Cash');
      expect(acc.type).toBe(AccountType.Asset);
      expect(acc.contra).toBe(false);
    });

    it('rejects duplicate names', async () => {
      await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await expect(
        ledger.createAccount({ name: 'Cash', type: AccountType.Asset }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates contra accounts', async () => {
      const acc = await ledger.createAccount({
        name: 'Drawing',
        type: AccountType.Equity,
        contra: true,
      });
      expect(acc.contra).toBe(true);
    });
  });

  describe('postEntry', () => {
    it('posts a balanced entry and updates balances', async () => {
      const cash = await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });

      const entry = await ledger.postEntry({
        description: 'Sale',
        debits: [{ accountName: 'Cash', amount: Amount.fromMajor(100) }],
        credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(100) }],
      });

      expect(entry.id).toBeTruthy();
      expect(entry.description).toBe('Sale');

      const bal = await ledger.accountBalance(cash);
      expect(bal.toMajor()).toBe('100.00');
    });

    it('accepts account objects directly', async () => {
      const cash = await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      const rev = await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });

      const entry = await ledger.postEntry({
        description: 'Sale',
        debits: [{ account: cash, amount: Amount.fromMajor(50) }],
        credits: [{ account: rev, amount: Amount.fromMajor(50) }],
      });
      expect(entry.debitAmounts[0]!.account.id).toBe(cash.id);
    });

    it('throws ValidationError when amounts do not cancel', async () => {
      await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });
      await expect(
        ledger.postEntry({
          description: 'Bad',
          debits: [{ accountName: 'Cash', amount: Amount.fromMajor(100) }],
          credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(99) }],
        }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
    });

    it('throws ValidationError when description is blank', async () => {
      await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });
      await expect(
        ledger.postEntry({
          description: '',
          debits: [{ accountName: 'Cash', amount: Amount.fromMajor(1) }],
          credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(1) }],
        }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
    });

    it('defaults the date to today', async () => {
      await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });
      const entry = await ledger.postEntry({
        description: 'Sale',
        debits: [{ accountName: 'Cash', amount: Amount.fromMajor(1) }],
        credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(1) }],
      });
      expect(entry.date).toBe(new Date().toISOString().slice(0, 10));
    });

    it('stores a commercial document reference', async () => {
      await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });
      const entry = await ledger.postEntry({
        description: 'Sale',
        commercialDocument: { id: 'inv-1', type: 'Invoice' },
        debits: [{ accountName: 'Cash', amount: Amount.fromMajor(1) }],
        credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(1) }],
      });
      expect(entry.commercialDocument).toEqual({ id: 'inv-1', type: 'Invoice' });
    });
  });

  describe('balances by type and date ranges', () => {
    it('aggregates balances across accounts of a type', async () => {
      await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Bank', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });

      await ledger.postEntry({
        description: 'Sale 1',
        date: '2024-01-10',
        debits: [{ accountName: 'Cash', amount: Amount.fromMajor(100) }],
        credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(100) }],
      });
      await ledger.postEntry({
        description: 'Sale 2',
        date: '2024-06-10',
        debits: [{ accountName: 'Bank', amount: Amount.fromMajor(50) }],
        credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(50) }],
      });

      expect((await ledger.balanceByType(AccountType.Asset)).toMajor()).toBe('150.00');
      expect((await ledger.balanceByType(AccountType.Revenue)).toMajor()).toBe('150.00');

      // Date range filter
      const partial = await ledger.balanceByType(AccountType.Asset, {
        fromDate: '2024-01-01',
        toDate: '2024-02-01',
      });
      expect(partial.toMajor()).toBe('100.00');
    });

    it('subtracts contra accounts in balanceByType', async () => {
      const cash = await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      const stock = await ledger.createAccount({ name: 'Common Stock', type: AccountType.Equity });
      const drawing = await ledger.createAccount({
        name: 'Drawing',
        type: AccountType.Equity,
        contra: true,
      });

      // Owner invests 1000: Cash (dr) 1000, Common Stock (cr) 1000
      await ledger.postEntry({
        description: 'Invest',
        debits: [{ account: cash, amount: Amount.fromMajor(1000) }],
        credits: [{ account: stock, amount: Amount.fromMajor(1000) }],
      });
      // Owner withdraws 400: Drawing (contra equity, dr) 400, Cash (cr) 400
      await ledger.postEntry({
        description: 'Withdraw',
        debits: [{ account: drawing, amount: Amount.fromMajor(400) }],
        credits: [{ account: cash, amount: Amount.fromMajor(400) }],
      });

      // Cash asset: 1000 - 400 = 600
      expect((await ledger.balanceByType(AccountType.Asset)).toMajor()).toBe('600.00');
      // Equity: Common Stock 1000 minus contra Drawing 400 = 600
      expect((await ledger.balanceByType(AccountType.Equity)).toMajor()).toBe('600.00');
      // Assets == Liabilities + Equity
      const bs = await ledger.balanceSheet();
      expect(bs.balanced.isZero()).toBe(true);
    });
  });

  describe('trialBalance', () => {
    it('is zero with no entries', async () => {
      expect((await ledger.trialBalance()).isZero()).toBe(true);
    });

    /**
     * Mirrors the Ruby `account_spec.rb` trial balance matrix: all 5 account
     * types plus 4 contra variants, posted as balanced entries, must net to 0.
     */
    it('is zero with balanced entries across all types and contra variants', async () => {
      const liability = await ledger.createAccount({ name: 'Liab', type: AccountType.Liability });
      const equity = await ledger.createAccount({ name: 'Equity', type: AccountType.Equity });
      const revenue = await ledger.createAccount({ name: 'Rev', type: AccountType.Revenue });
      const contraAsset = await ledger.createAccount({
        name: 'CAsset',
        type: AccountType.Asset,
        contra: true,
      });
      const contraExpense = await ledger.createAccount({
        name: 'CExp',
        type: AccountType.Expense,
        contra: true,
      });

      const asset = await ledger.createAccount({ name: 'Asset', type: AccountType.Asset });
      const expense = await ledger.createAccount({ name: 'Exp', type: AccountType.Expense });
      const contraLiability = await ledger.createAccount({
        name: 'CLiab',
        type: AccountType.Liability,
        contra: true,
      });
      const contraEquity = await ledger.createAccount({
        name: 'CEq',
        type: AccountType.Equity,
        contra: true,
      });
      const contraRevenue = await ledger.createAccount({
        name: 'CRev',
        type: AccountType.Revenue,
        contra: true,
      });

      const cases: [Account, Account, number][] = [
        [liability, asset, 100000],
        [equity, expense, 1000],
        [revenue, contraLiability, 40404],
        [contraAsset, contraEquity, 2],
        [contraExpense, contraRevenue, 333],
      ];
      for (const [creditAcc, debitAcc, amount] of cases) {
        await ledger.postEntry({
          description: 'entry',
          debits: [{ account: debitAcc, amount: Amount.fromMajor(amount) }],
          credits: [{ account: creditAcc, amount: Amount.fromMajor(amount) }],
        });
      }

      expect((await ledger.trialBalance()).isZero()).toBe(true);
    });
  });

  describe('reports', () => {
    it('produces a balance sheet that balances', async () => {
      await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Equity', type: AccountType.Equity });
      await ledger.postEntry({
        description: 'Invest',
        debits: [{ accountName: 'Cash', amount: Amount.fromMajor(500) }],
        credits: [{ accountName: 'Equity', amount: Amount.fromMajor(500) }],
      });
      const bs = await ledger.balanceSheet();
      expect(bs.assets.toMajor()).toBe('500.00');
      expect(bs.equity.toMajor()).toBe('500.00');
      expect(bs.balanced.isZero()).toBe(true);
    });

    it('produces an income statement', async () => {
      await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });
      await ledger.createAccount({ name: 'Expense', type: AccountType.Expense });
      await ledger.postEntry({
        description: 'Earn',
        debits: [{ accountName: 'Cash', amount: Amount.fromMajor(300) }],
        credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(300) }],
      });
      await ledger.postEntry({
        description: 'Spend',
        debits: [{ accountName: 'Expense', amount: Amount.fromMajor(100) }],
        credits: [{ accountName: 'Cash', amount: Amount.fromMajor(100) }],
      });
      const is = await ledger.incomeStatement();
      expect(is.revenue.toMajor()).toBe('300.00');
      expect(is.expenses.toMajor()).toBe('100.00');
      expect(is.netIncome.toMajor()).toBe('200.00');
    });
  });

  describe('account associations', () => {
    it('returns all amounts and entries for an account', async () => {
      const equity = await ledger.createAccount({ name: 'Equity', type: AccountType.Equity });
      const asset = await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
      const expense = await ledger.createAccount({ name: 'Exp', type: AccountType.Expense });

      await ledger.postEntry({
        description: 'Invest',
        debits: [{ accountName: 'Cash', amount: Amount.fromMajor(1000) }],
        credits: [{ accountName: 'Equity', amount: Amount.fromMajor(1000) }],
      });
      await ledger.postEntry({
        description: 'Buy computer',
        debits: [{ accountName: 'Exp', amount: Amount.fromMajor(900) }],
        credits: [{ accountName: 'Cash', amount: Amount.fromMajor(900) }],
      });

      expect((await ledger.amountsForAccount(equity)).length).toBe(1);
      expect((await ledger.amountsForAccount(asset)).length).toBe(2);
      expect((await ledger.amountsForAccount(expense)).length).toBe(1);

      expect((await ledger.entriesForAccount(equity)).length).toBe(1);
      expect((await ledger.entriesForAccount(asset)).length).toBe(2);
      expect((await ledger.entriesForAccount(expense)).length).toBe(1);
    });
  });
});
