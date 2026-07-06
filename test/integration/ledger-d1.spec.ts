import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1Repository } from '../../src/db/d1-repository.js';
import { Amount } from '../../src/domain/amount.js';
import { ValidationError } from '../../src/domain/errors.js';
import { Ledger } from '../../src/domain/ledger.js';
import { AccountType } from '../../src/domain/types.js';
import { createTestD1, truncateAll } from '../helpers/miniflare.js';

describe('Ledger over D1 (end-to-end)', () => {
  let d1: D1Database;
  let ledger: Ledger;

  beforeEach(async () => {
    d1 = await createTestD1();
    ledger = new Ledger(new D1Repository(d1));
  });

  afterEach(async () => {
    await truncateAll(d1);
  });

  it('posts entries and reports account balances', async () => {
    const cash = await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
    await ledger.createAccount({ name: 'Sales Revenue', type: AccountType.Revenue });
    await ledger.createAccount({ name: 'Sales Tax Payable', type: AccountType.Liability });
    await ledger.createAccount({ name: 'Accounts Receivable', type: AccountType.Asset });

    // Multi-credit entry: AR 50 dr; Revenue 45 cr, Tax 5 cr
    await ledger.postEntry({
      description: 'Sold widgets',
      commercialDocument: { id: 'inv-1', type: 'Invoice' },
      debits: [{ accountName: 'Accounts Receivable', amount: Amount.fromMajor(50) }],
      credits: [
        { accountName: 'Sales Revenue', amount: Amount.fromMajor(45) },
        { accountName: 'Sales Tax Payable', amount: Amount.fromMajor(5) },
      ],
    });

    expect((await ledger.accountBalance(cash)).isZero()).toBe(true);
    const ar = (await ledger.getAccountByName('Accounts Receivable'))!;
    expect((await ledger.accountBalance(ar)).toMajor()).toBe('50.00');
  });

  it('rejects unbalanced entries', async () => {
    await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
    await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });

    await expect(
      ledger.postEntry({
        description: 'Bad',
        debits: [{ accountName: 'Cash', amount: Amount.fromMajor(100) }],
        credits: [{ accountName: 'Revenue', amount: Amount.fromMajor(90) }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing persisted.
    expect(await ledger.allEntries()).toHaveLength(0);
  });

  it('preserves the trial balance invariant across all account types', async () => {
    const accounts = {
      asset: await ledger.createAccount({ name: 'Asset', type: AccountType.Asset }),
      liability: await ledger.createAccount({ name: 'Liability', type: AccountType.Liability }),
      equity: await ledger.createAccount({ name: 'Equity', type: AccountType.Equity }),
      revenue: await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue }),
      expense: await ledger.createAccount({ name: 'Expense', type: AccountType.Expense }),
      contraAsset: await ledger.createAccount({
        name: 'CAsset',
        type: AccountType.Asset,
        contra: true,
      }),
      contraExpense: await ledger.createAccount({
        name: 'CExpense',
        type: AccountType.Expense,
        contra: true,
      }),
      contraLiability: await ledger.createAccount({
        name: 'CLiab',
        type: AccountType.Liability,
        contra: true,
      }),
      contraEquity: await ledger.createAccount({
        name: 'CEquity',
        type: AccountType.Equity,
        contra: true,
      }),
      contraRevenue: await ledger.createAccount({
        name: 'CRevenue',
        type: AccountType.Revenue,
        contra: true,
      }),
    };

    const entries: [string, string, number][] = [
      ['liability', 'asset', 100000],
      ['equity', 'expense', 1000],
      ['revenue', 'contraLiability', 40404],
      ['contraAsset', 'contraEquity', 2],
      ['contraExpense', 'contraRevenue', 333],
    ];
    for (const [creditKey, debitKey, amount] of entries) {
      await ledger.postEntry({
        description: 'entry',
        debits: [
          {
            account: accounts[debitKey as keyof typeof accounts],
            amount: Amount.fromMajor(amount),
          },
        ],
        credits: [
          {
            account: accounts[creditKey as keyof typeof accounts],
            amount: Amount.fromMajor(amount),
          },
        ],
      });
    }

    expect((await ledger.trialBalance()).isZero()).toBe(true);
  });

  it('generates a balanced balance sheet and an income statement', async () => {
    await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
    await ledger.createAccount({ name: 'Equity', type: AccountType.Equity });
    await ledger.createAccount({ name: 'Revenue', type: AccountType.Revenue });
    await ledger.createAccount({ name: 'Expense', type: AccountType.Expense });

    await ledger.postEntry({
      description: 'Invest',
      debits: [{ accountName: 'Cash', amount: Amount.fromMajor(1000) }],
      credits: [{ accountName: 'Equity', amount: Amount.fromMajor(1000) }],
    });
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

    const bs = await ledger.balanceSheet();
    expect(bs.balanced.isZero()).toBe(true);
    expect(bs.assets.toMajor()).toBe('1200.00');

    const is = await ledger.incomeStatement({ fromDate: '2000-01-01', toDate: '2999-12-31' });
    expect(is.netIncome.toMajor()).toBe('200.00');
  });

  it('enforces account name uniqueness', async () => {
    await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
    await expect(
      ledger.createAccount({ name: 'Cash', type: AccountType.Asset }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
