import type { Repository } from '../db/repository.js';
import { type Account, aggregateBalances, computeBalance } from './account.js';
import { type AmountRecord, type Entry, type EntryPayload, buildEntry } from './entry.js';
import { ValidationError } from './errors.js';
import {
  type CreateAccountInput,
  type EntryInput,
  createAccountSchema,
  toIssues,
} from './schemas.js';
import { AccountType, type DateRange } from './types.js';

/**
 * Balances are signed `bigint` minor units. A balance may legitimately be
 * negative (e.g. an overdrawn asset), which the strictly-non-negative
 * {@link Amount} type cannot represent, so report fields expose raw `bigint`.
 * Format for display with {@link formatAmount} from `./amount.js`.
 */
export interface BalanceSheet {
  assets: bigint;
  liabilities: bigint;
  equity: bigint;
  /** Assets - (Liabilities + Equity + Net Income). Should be zero in a balanced ledger. */
  balanced: bigint;
}

export interface IncomeStatement {
  revenue: bigint;
  expenses: bigint;
  netIncome: bigint;
}

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
    // The DB unique index (name, type) is the source of truth; insertAccount
    // catches the constraint violation and re-throws as ValidationError. This
    // avoids a check-then-act TOCTOU window under concurrent DO requests.
    return this.repo.insertAccount(parsed.data);
  }

  /**
   * Validate and persist an entry. Each amount may reference an account either
   * directly (`account`) or by name (`accountName`, resolved against the repo).
   * Amounts accept `number | string | Amount`. Throws {@link ValidationError}
   * on failure with a flat list of path-tagged issues.
   */
  async postEntry(input: EntryInput): Promise<Entry> {
    // Exactly-once posting: if a client-supplied idempotency key is present and
    // a matching entry was already persisted, return it instead of re-posting.
    // This guards against retries in a Durable Object (network replays or
    // re-execution after eviction) that would otherwise create a silent duplicate.
    if (input.idempotencyKey) {
      const existing = await this.repo.getEntryByKey(input.idempotencyKey);
      if (existing) return existing;
    }

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

  /** All accounts, ordered by name. */
  async allAccounts(): Promise<Account[]> {
    return this.repo.allAccounts();
  }

  /** Balance of a single account, optionally within a date range. */
  async accountBalance(account: Account, range?: DateRange): Promise<bigint> {
    const [credits, debits] = await Promise.all([
      this.repo.sumCredits(account.id, range),
      this.repo.sumDebits(account.id, range),
    ]);
    return computeBalance(account.type, account.contra, credits, debits);
  }

  /** Aggregate balance of all accounts of a type (contra accounts subtracted). */
  async balanceByType(type: AccountType, range?: DateRange): Promise<bigint> {
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
   * Asset - (Liability + Equity + Revenue - Expense). Optionally scoped to a
   * date range (all entries up to/within the range), matching `balanceSheet`
   * and `incomeStatement`.
   */
  async trialBalance(range?: DateRange): Promise<bigint> {
    const [assets, liabilities, equity, revenue, expenses] = await Promise.all([
      this.balanceByType(AccountType.Asset, range),
      this.balanceByType(AccountType.Liability, range),
      this.balanceByType(AccountType.Equity, range),
      this.balanceByType(AccountType.Revenue, range),
      this.balanceByType(AccountType.Expense, range),
    ]);
    return assets - (liabilities + equity + revenue - expenses);
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
    const netIncome = revenue - expenses;
    return {
      assets,
      liabilities,
      equity,
      balanced: assets - (liabilities + equity + netIncome),
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
      netIncome: revenue - expenses,
    };
  }

  async entriesForAccount(account: Account): Promise<Entry[]> {
    return this.repo.entriesForAccount(account.id);
  }

  async amountsForAccount(account: Account): Promise<AmountRecord[]> {
    return this.repo.amountsForAccount(account.id);
  }

  async allEntries(order: 'asc' | 'desc' = 'desc'): Promise<Entry[]> {
    return this.repo.allEntries(order);
  }
}
