import type { z } from 'zod';
import type { Repository } from '../db/repository.js';
import { type Account, aggregateBalances, computeBalance } from './account.js';
import { Amount } from './amount.js';
import { type Entry, type EntryPayload, buildEntry } from './entry.js';
import { ValidationError } from './errors.js';
import { type EntryInput, createAccountSchema, toIssues } from './schemas.js';
import { AccountType, type DateRange } from './types.js';

export interface BalanceSheet {
  assets: Amount;
  liabilities: Amount;
  equity: Amount;
  /** Assets - (Liabilities + Equity + Net Income). Should be zero in a balanced ledger. */
  balanced: Amount;
}

export interface IncomeStatement {
  revenue: Amount;
  expenses: Amount;
  netIncome: Amount;
}

export type CreateAccountInput = z.input<typeof createAccountSchema>;

/**
 * High-level facade over a {@link Repository}. Provides the accounting
 * operations of the Pluts domain: account creation, entry posting, and
 * balance/report queries. This is the primary public API surface.
 */
export class Ledger {
  constructor(private readonly repo: Repository) {}

  async createAccount(input: CreateAccountInput): Promise<Account> {
    const parsed = createAccountSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(toIssues(parsed.error.issues), 'Invalid account input');
    }
    const existing = await this.repo.getAccountByName(parsed.data.name);
    if (existing) {
      throw new ValidationError(
        [{ path: ['name'], message: 'has already been taken' }],
        'Account already exists',
      );
    }
    return this.repo.insertAccount(parsed.data);
  }

  /**
   * Validate and persist an entry. Each amount may reference an account either
   * directly (`account`) or by name (`accountName`, resolved against the repo).
   * Amounts accept `number | string | Amount`. Throws {@link ValidationError}
   * on failure with a flat list of path-tagged issues.
   */
  async postEntry(input: EntryInput): Promise<Entry> {
    const names = new Set<string>();
    for (const a of [...input.debits, ...input.credits]) {
      if (a.accountName) names.add(a.accountName);
    }
    const accountMap = new Map<string, Account>();
    for (const name of names) {
      const acc = await this.repo.getAccountByName(name);
      if (acc) accountMap.set(name, acc);
    }

    const payload: EntryPayload = buildEntry(input, (name) => accountMap.get(name) ?? null);
    return this.repo.insertEntry(payload);
  }

  async getAccount(id: string): Promise<Account | null> {
    return this.repo.getAccount(id);
  }

  async getAccountByName(name: string): Promise<Account | null> {
    return this.repo.getAccountByName(name);
  }

  /** Balance of a single account, optionally within a date range. */
  async accountBalance(account: Account, range?: DateRange): Promise<Amount> {
    const [credits, debits] = await Promise.all([
      this.repo.sumCredits(account.id, range),
      this.repo.sumDebits(account.id, range),
    ]);
    return computeBalance(account.type, account.contra, credits, debits);
  }

  /** Aggregate balance of all accounts of a type (contra accounts subtracted). */
  async balanceByType(type: AccountType, range?: DateRange): Promise<Amount> {
    const accounts = await this.repo.getAccountsByType(type);
    const balances = await Promise.all(
      accounts.map(async (a) => ({
        type: a.type,
        contra: a.contra,
        balance: await this.accountBalance(a, range),
      })),
    );
    return aggregateBalances(balances, type);
  }

  /**
   * Trial balance: should always be zero for a balanced ledger.
   * Asset - (Liability + Equity + Revenue - Expense).
   */
  async trialBalance(): Promise<Amount> {
    const [assets, liabilities, equity, revenue, expenses] = await Promise.all([
      this.balanceByType(AccountType.Asset),
      this.balanceByType(AccountType.Liability),
      this.balanceByType(AccountType.Equity),
      this.balanceByType(AccountType.Revenue),
      this.balanceByType(AccountType.Expense),
    ]);
    return Amount.fromSigned(
      assets.signed() -
        (liabilities.signed() + equity.signed() + revenue.signed() - expenses.signed()),
    );
  }

  async balanceSheet(range?: DateRange): Promise<BalanceSheet> {
    const [assets, liabilities, equity, revenue, expenses] = await Promise.all([
      this.balanceByType(AccountType.Asset, range),
      this.balanceByType(AccountType.Liability, range),
      this.balanceByType(AccountType.Equity, range),
      this.balanceByType(AccountType.Revenue, range),
      this.balanceByType(AccountType.Expense, range),
    ]);
    // Net income (revenue - expenses) is retained earnings, part of equity on
    // a real balance sheet. The balanced check includes it so the accounting
    // equation holds: Assets = Liabilities + Equity + Net Income.
    const netIncome = Amount.fromSigned(revenue.signed() - expenses.signed());
    return {
      assets,
      liabilities,
      equity,
      balanced: Amount.fromSigned(
        assets.signed() - (liabilities.signed() + equity.signed() + netIncome.signed()),
      ),
    };
  }

  async incomeStatement(range?: DateRange): Promise<IncomeStatement> {
    const [revenue, expenses] = await Promise.all([
      this.balanceByType(AccountType.Revenue, range),
      this.balanceByType(AccountType.Expense, range),
    ]);
    return {
      revenue,
      expenses,
      netIncome: Amount.fromSigned(revenue.signed() - expenses.signed()),
    };
  }

  async entriesForAccount(account: Account): Promise<Entry[]> {
    return this.repo.entriesForAccount(account.id);
  }

  async amountsForAccount(account: Account) {
    return this.repo.amountsForAccount(account.id);
  }

  async allEntries(order: 'asc' | 'desc' = 'desc'): Promise<Entry[]> {
    return this.repo.allEntries(order);
  }
}
