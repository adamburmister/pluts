import type { Repository } from "../db/repository.js";
import { type Account, aggregateBalances, computeBalance } from "./account.js";
import {
  type AmountRecord,
  buildEntry,
  computeEntryFingerprint,
  type Entry,
  type EntryPayload,
} from "./entry.js";
import { IdempotencyConflictError, ValidationError } from "./errors.js";
import {
  type CreateAccountInput,
  createAccountSchema,
  dateRangeSchema,
  type EntryInput,
  toIssues,
} from "./schemas.js";
import { AccountType, type DateRange } from "./types.js";

/**
 * Balances are signed `bigint` minor units. A balance may legitimately be
 * negative (e.g. an overdrawn asset), which the strictly-non-negative
 * {@link Amount} type cannot represent, so report fields expose raw `bigint`.
 * Format for display with {@link formatAmount} from `./amount.js`.
 */
export interface BalanceSheet {
  assets: bigint;
  liabilities: bigint;
  /**
   * Equity from equity-type accounts only. This *excludes* net income
   * (pre-closing retained earnings), which is reported separately as
   * {@link BalanceSheet.netIncome}. The full accounting equation is
   * `assets === liabilities + equity + netIncome`.
   */
  equity: bigint;
  /**
   * Lifetime net income (revenue - expenses) = pre-closing retained earnings.
   * On a closed-books balance sheet this would be folded into equity; here it
   * is surfaced explicitly so consumers can reconcile the accounting equation
   * from the returned fields alone.
   */
  netIncome: bigint;
  /** Assets - (Liabilities + Equity + Net Income). Should be zero in a balanced ledger. */
  balanced: bigint;
}

export interface IncomeStatement {
  revenue: bigint;
  expenses: bigint;
  netIncome: bigint;
}

/**
 * One line of a classic trial balance: the account's net balance placed in
 * its debit or credit column (the other column is 0n). Minor units.
 */
export interface TrialBalanceRow {
  account: Account;
  debit: bigint;
  credit: bigint;
}

/**
 * The classic trial balance listing: every account with its balance in the
 * debit or credit column. `totalDebits === totalCredits` (i.e. `balanced`)
 * is the whole-ledger proof an auditor expects to run.
 */
export interface TrialBalanceReport {
  rows: TrialBalanceRow[];
  totalDebits: bigint;
  totalCredits: bigint;
  balanced: boolean;
}

/** Normalize an optional as-of date to the DateRange the repository expects. */
function asOfRange(asOf?: Date | string): DateRange | undefined {
  return asOf === undefined ? undefined : { toDate: asOf };
}

/**
 * High-level facade over a {@link Repository}. Provides the accounting
 * operations of the Pluts domain: account creation, entry posting, and
 * balance/report queries. This is the primary public API surface.
 */
export class Ledger {
  constructor(private readonly repo: Repository) {}

  /**
   * Validate and normalize an optional date range before it reaches the
   * repository. Range bounds filter entries by lexicographic comparison, so a
   * malformed bound would silently mis-filter every period report (F-02).
   * Throws {@link ValidationError} on malformed bounds.
   */
  private parseRange(range?: DateRange): DateRange | undefined {
    const parsed = dateRangeSchema.safeParse(range);
    if (!parsed.success) {
      throw new ValidationError(
        toIssues(parsed.error.issues),
        "Invalid date range",
      );
    }
    if (!parsed.data) return undefined;
    const { fromDate, toDate } = parsed.data;
    return {
      ...(fromDate !== undefined ? { fromDate } : {}),
      ...(toDate !== undefined ? { toDate } : {}),
    };
  }

  async createAccount(input: CreateAccountInput): Promise<Account> {
    const parsed = createAccountSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        toIssues(parsed.error.issues),
        "Invalid account input",
      );
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
    // Prefetch account names for the resolver. Tolerate malformed shapes
    // here — buildEntry's schema parse below is the validation authority and
    // turns them into a path-tagged ValidationError; blowing up in this scan
    // would surface a raw TypeError instead.
    const names = new Set<string>();
    const lines = [
      ...(Array.isArray(input.debits) ? input.debits : []),
      ...(Array.isArray(input.credits) ? input.credits : []),
    ];
    for (const a of lines) {
      if (typeof a?.accountName === "string" && a.accountName) {
        names.add(a.accountName);
      }
    }
    const accountMap = new Map<string, Account>();
    for (const name of names) {
      const acc = await this.repo.getAccountByName(name);
      if (acc) accountMap.set(name, acc);
    }

    // Validate FIRST — an invalid payload is invalid input, never a dedup hit.
    const payload: EntryPayload = buildEntry(
      input,
      (name) => accountMap.get(name) ?? null,
    );

    // Exactly-once posting: a byte-identical retry (network replay, DO
    // re-execution after eviction) returns the already-persisted entry. The
    // stored payload fingerprint distinguishes that from a key *collision* —
    // the same key carrying different business content — which must fail
    // loudly instead of silently dropping the second transaction.
    if (payload.idempotencyKey) {
      const fingerprint = await computeEntryFingerprint(payload);
      const keyRecord = await this.repo.getEntryKeyRecord(
        payload.idempotencyKey,
      );
      if (keyRecord) {
        if (keyRecord.payloadHash !== fingerprint) {
          throw new IdempotencyConflictError(
            payload.idempotencyKey,
            keyRecord.entryId,
          );
        }
        // Matching fingerprint: genuine retry, return the original.
        const existing = await this.repo.getEntry(keyRecord.entryId);
        if (existing) return existing;
      }
    }

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
    const parsedRange = this.parseRange(range);
    const [credits, debits] = await Promise.all([
      this.repo.sumCredits(account.id, parsedRange),
      this.repo.sumDebits(account.id, parsedRange),
    ]);
    return computeBalance(account.type, account.contra, credits, debits);
  }

  /** Aggregate balance of all accounts of a type (contra accounts subtracted). */
  async balanceByType(type: AccountType, range?: DateRange): Promise<bigint> {
    range = this.parseRange(range);
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
   *
   * Point-in-time: cumulative over all entries up to and including `asOf`
   * (default: everything). A trial balance is not a period statement, so a
   * from-date is deliberately unrepresentable here.
   */
  async trialBalance(asOf?: Date | string): Promise<bigint> {
    const range = this.parseRange(asOfRange(asOf));
    const [assets, liabilities, equity, revenue, expenses] = await Promise.all([
      this.balanceByType(AccountType.Asset, range),
      this.balanceByType(AccountType.Liability, range),
      this.balanceByType(AccountType.Equity, range),
      this.balanceByType(AccountType.Revenue, range),
      this.balanceByType(AccountType.Expense, range),
    ]);
    return assets - (liabilities + equity + revenue - expenses);
  }

  /**
   * The classic trial balance listing: every account with its net balance in
   * the debit or credit column, plus column totals. Equal totals prove the
   * whole ledger balances. Point-in-time (cumulative up to `asOf`).
   */
  async trialBalanceReport(asOf?: Date | string): Promise<TrialBalanceReport> {
    const range = this.parseRange(asOfRange(asOf));
    const accounts = await this.repo.allAccounts();
    const rows: TrialBalanceRow[] = [];
    let totalDebits = 0n;
    let totalCredits = 0n;
    for (const account of accounts) {
      const [credits, debits] = await Promise.all([
        this.repo.sumCredits(account.id, range),
        this.repo.sumDebits(account.id, range),
      ]);
      // Raw debit/credit arithmetic, independent of account type or contra
      // flag: the net lands in whichever column it favors.
      const net = debits.minor - credits.minor;
      const row: TrialBalanceRow =
        net >= 0n
          ? { account, debit: net, credit: 0n }
          : { account, debit: 0n, credit: -net };
      rows.push(row);
      totalDebits += row.debit;
      totalCredits += row.credit;
    }
    return {
      rows,
      totalDebits,
      totalCredits,
      balanced: totalDebits === totalCredits,
    };
  }

  /**
   * Balance sheet as of a date: cumulative from inception to `asOf`
   * (default: everything). Point-in-time by construction — a "balance sheet
   * for a period" is not a statement an accountant can name, so the previous
   * DateRange parameter (which permitted a fromDate) is gone; use
   * {@link incomeStatement} for period (flow) reporting.
   */
  async balanceSheet(asOf?: Date | string): Promise<BalanceSheet> {
    const range = this.parseRange(asOfRange(asOf));
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
      netIncome,
      balanced: assets - (liabilities + equity + netIncome),
    };
  }

  async incomeStatement(range?: DateRange): Promise<IncomeStatement> {
    range = this.parseRange(range);
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

  async allEntries(order: "asc" | "desc" = "desc"): Promise<Entry[]> {
    return this.repo.allEntries(order);
  }

  /**
   * Journal gap check: sequence numbers are assigned monotonically from 1
   * with no gaps, so a journal of N entries has MAX(seq) === N. Returns
   * false when entries are missing *between* surviving rows — any removal
   * except a contiguous truncation of the tail, which shifts MAX(seq) and
   * COUNT(*) together and is invisible to this check. Proving "nothing was
   * ever removed" would need a high-water mark persisted outside the entry
   * rows; this method deliberately claims only gap-freedom.
   */
  async verifyNoSequenceGaps(): Promise<boolean> {
    const { count, maxSeq } = await this.repo.entrySequenceStats();
    return maxSeq === count;
  }
}
