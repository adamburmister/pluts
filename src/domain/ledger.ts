import type {
  AccountTotals,
  AccountTotalsOptions,
  EntryPageOptions,
  EntryWalkOptions,
  Repository,
} from "../db/repository.js";
import {
  type Account,
  accountNameKey,
  aggregateBalances,
  computeBalance,
} from "./account.js";
import type { AccountId } from "./branded.js";
import { type AccountDTO, toAccountDTO } from "./dto.js";
import {
  type AmountRecord,
  buildEntry,
  computeEntryFingerprint,
  type Entry,
  type EntryPayload,
} from "./entry.js";
import {
  IdempotencyConflictError,
  ValidationError,
  type ValidationIssue,
} from "./errors.js";
import {
  type CreateAccountInput,
  createAccountSchema,
  dateRangeSchema,
  type EntryInput,
  entryPageSchema,
  entryWalkSchema,
  toIssues,
} from "./schemas.js";
import { AccountType, type DateRange, utcToday } from "./types.js";

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
  /**
   * The residual `assets - (liabilities + equity + netIncome)`: zero in a
   * healthy ledger, and the size of the discrepancy when it is not.
   *
   * Named for what it measures rather than for the healthy case, so it cannot
   * be confused with the boolean {@link TrialBalanceReport.balanced} — `if
   * (sheet.imbalance)` reads the way it behaves, where `if (sheet.balanced)`
   * on a `bigint` residual read backwards.
   */
  imbalance: bigint;
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
 * Turn per-account credit/debit totals into the type/contra/balance shape
 * {@link aggregateBalances} consumes.
 */
function toBalances(
  totals: readonly AccountTotals[],
): { type: AccountType; contra: boolean; balance: bigint }[] {
  return totals.map(({ account, credits, debits }) => ({
    type: account.type,
    contra: account.contra,
    balance: computeBalance(account.type, account.contra, credits, debits),
  }));
}

/** Every account type, for reports that span the whole chart of accounts. */
const ALL_ACCOUNT_TYPES = [
  AccountType.Asset,
  AccountType.Liability,
  AccountType.Equity,
  AccountType.Revenue,
  AccountType.Expense,
] as const;

/** The two types an income statement reports on. */
const INCOME_STATEMENT_TYPES = [
  AccountType.Revenue,
  AccountType.Expense,
] as const;

/** Construction options for {@link Ledger}. */
export interface LedgerOptions {
  /**
   * Supplies the `yyyy-mm-dd` used when {@link Ledger.postEntry} is called
   * without a `date`. Defaults to {@link utcToday} — the **UTC** calendar
   * day. Pass `todayInTimeZone("Pacific/Auckland")` (or any function
   * returning an ISO date) to default entries to a local calendar day
   * instead; east of UTC the two differ for a large part of the working day
   * and can straddle a month-end period boundary.
   */
  today?: () => string;
}

/**
 * High-level facade over a {@link Repository}. Provides the accounting
 * operations of the Pluts domain: account creation, entry posting, and
 * balance/report queries. This is the primary public API surface.
 */
export class Ledger {
  private readonly today: () => string;

  constructor(
    private readonly repo: Repository,
    options: LedgerOptions = {},
  ) {
    this.today = options.today ?? utcToday;
  }

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
   * directly (`account`) or by name (`accountName`); either way the account
   * must exist in this ledger. Amounts accept `number | string | Amount`.
   * Throws {@link ValidationError} on failure with a flat list of path-tagged
   * issues — nothing is written.
   *
   * An omitted `date` defaults to the **UTC** calendar day unless a `today`
   * option was passed to the constructor (see {@link LedgerOptions.today}).
   */
  /**
   * Look up, in one pass before validation, every account an entry's lines
   * refer to: by name for `accountName` lines, by id for lines carrying an
   * `Account` object. Returns the resolved name map plus the set of ids the
   * ledger actually holds.
   *
   * Tolerates malformed shapes — buildEntry's schema parse is the validation
   * authority, and blowing up in this scan would surface a raw TypeError
   * instead of a path-tagged ValidationError.
   */
  private async prefetchAccounts(
    input: EntryInput,
  ): Promise<{ byName: Map<string, Account>; knownIds: Set<AccountId> }> {
    const names = new Set<string>();
    const ids = new Set<AccountId>();
    const lines = [
      ...(Array.isArray(input.debits) ? input.debits : []),
      ...(Array.isArray(input.credits) ? input.credits : []),
    ];
    for (const line of lines) {
      if (typeof line?.accountName === "string" && line.accountName) {
        names.add(accountNameKey(line.accountName));
      }
      if (typeof line?.account?.id === "string" && line.account.id) {
        ids.add(line.account.id);
      }
    }

    const byName = new Map<string, Account>();
    for (const name of names) {
      const found = await this.repo.getAccountByName(name);
      if (found) byName.set(name, found);
    }

    // A name that resolved names an account that exists by definition; only
    // the caller-supplied ids still need confirming.
    const knownIds = new Set<AccountId>(
      [...byName.values()].map((account) => account.id),
    );
    for (const id of ids) {
      if (knownIds.has(id)) continue;
      const found = await this.repo.getAccount(id);
      if (found) knownIds.add(id);
    }
    return { byName, knownIds };
  }

  /**
   * Reject lines whose `Account` object is not an account of *this* ledger.
   *
   * An `Account` handed to {@link postEntry} is caller-supplied data, not a
   * capability: it can be hand-built, stale, or borrowed from another
   * ledger's Durable Object. Left unchecked it reaches the foreign-key
   * constraint and surfaces as an opaque `RepositoryError`, while the same
   * mistake spelled as an `accountName` gives a path-tagged
   * {@link ValidationError} (issue #29). Both spellings get one contract.
   *
   * Runs on the built payload, where every line resolved, so line indices
   * still match the caller's input.
   */
  private assertAccountsExist(
    payload: EntryPayload,
    knownIds: ReadonlySet<AccountId>,
  ): void {
    const issues: ValidationIssue[] = [];
    const check = (
      lines: EntryPayload["debits"],
      root: "debits" | "credits",
    ) => {
      lines.forEach((line, index) => {
        if (knownIds.has(line.account.id)) return;
        issues.push({
          path: [root, index, "account"],
          message: `Account "${line.account.id}" not found`,
        });
      });
    };
    check(payload.debits, "debits");
    check(payload.credits, "credits");
    if (issues.length > 0) {
      throw new ValidationError(issues, "Unknown account");
    }
  }

  async postEntry(input: EntryInput): Promise<Entry> {
    const { byName, knownIds } = await this.prefetchAccounts(input);

    // Validate FIRST — an invalid payload is invalid input, never a dedup hit.
    const payload: EntryPayload = buildEntry(
      input,
      (name) => byName.get(accountNameKey(name)) ?? null,
      this.today,
    );
    this.assertAccountsExist(payload, knownIds);

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

  async getAccount(id: AccountId): Promise<Account | null> {
    return this.repo.getAccount(id);
  }

  async getAccountByName(name: string): Promise<Account | null> {
    return this.repo.getAccountByName(accountNameKey(name));
  }

  /** All accounts, ordered by name. */
  async allAccounts(): Promise<Account[]> {
    return this.repo.allAccounts();
  }

  /**
   * Every account as a boundary-safe {@link AccountDTO}, each carrying its
   * current net balance (signed, in major units). One repository read, so the
   * balances describe a single instant of the ledger.
   *
   * Use this for any "list accounts with their balances" view — a dashboard,
   * a chart of accounts, a reconciliation screen. It is deliberately separate
   * from {@link allAccounts}: that path is cheap and balance-free, while this
   * one computes a balance per account. Cumulative up to and including `asOf`
   * (default: everything); pass a range to bound it to a period.
   */
  async accountsWithBalances(
    options?: AccountTotalsOptions,
  ): Promise<AccountDTO[]> {
    const totals = await this.repo.accountTotals(options);
    return totals.map(({ account, credits, debits }) =>
      toAccountDTO(
        account,
        computeBalance(account.type, account.contra, credits, debits),
      ),
    );
  }

  /**
   * Net debit/credit sum for one account over an already-validated range,
   * oriented to the account's normal balance. The shared primitive behind
   * both balance (as-of) and movement (period) queries.
   */
  private async netForAccount(
    account: Account,
    range?: DateRange,
  ): Promise<bigint> {
    const [credits, debits] = await Promise.all([
      this.repo.sumCredits(account.id, range),
      this.repo.sumDebits(account.id, range),
    ]);
    return computeBalance(account.type, account.contra, credits, debits);
  }

  /**
   * Aggregate net sum for all accounts of a type (contra subtracted) over an
   * already-validated range. Shared by the public balance/movement methods
   * and the report builders, which pass ranges they validated themselves.
   *
   * One repository call, so every account is summed from the same view of the
   * ledger — see {@link Repository.accountTotals}.
   */
  private async netByType(
    type: AccountType,
    range?: DateRange,
  ): Promise<bigint> {
    const totals = await this.repo.accountTotals({
      types: [type],
      ...(range !== undefined ? { range } : {}),
    });
    return aggregateBalances(toBalances(totals), type);
  }

  /**
   * Balance of a single account: cumulative from inception up to and
   * including `asOf` (default: everything). Point-in-time by construction —
   * a from-bounded "balance" is really a period movement and was misleading
   * for balance-sheet accounts (#26); use {@link accountMovement} for that.
   */
  async accountBalance(
    account: Account,
    asOf?: Date | string,
  ): Promise<bigint> {
    return this.netForAccount(account, this.parseRange(asOfRange(asOf)));
  }

  /**
   * Net movement of a single account within `range`, oriented to the
   * account's normal balance (e.g. a cash inflow is positive for an asset).
   * For P&L accounts this is the period figure an income statement reports;
   * for balance-sheet accounts it is the period *change*, not a balance.
   */
  async accountMovement(account: Account, range: DateRange): Promise<bigint> {
    return this.netForAccount(account, this.parseRange(range));
  }

  /**
   * Aggregate balance of all accounts of a type (contra accounts
   * subtracted), cumulative up to `asOf` (default: everything). See
   * {@link accountBalance} for the balance/movement split; use
   * {@link movementByType} for period figures.
   */
  async balanceByType(
    type: AccountType,
    asOf?: Date | string,
  ): Promise<bigint> {
    return this.netByType(type, this.parseRange(asOfRange(asOf)));
  }

  /**
   * Aggregate net movement of all accounts of a type (contra subtracted)
   * within `range`. The building block of period (flow) reporting.
   */
  async movementByType(type: AccountType, range: DateRange): Promise<bigint> {
    return this.netByType(type, this.parseRange(range));
  }

  /**
   * Net sum of each requested account type over an already-validated range,
   * from a single repository read.
   *
   * The multi-type reports (trial balance, balance sheet, income statement)
   * all derive from this: one query means every figure in a statement
   * describes the same instant of the ledger, so a write landing mid-report
   * cannot make the statement contradict itself. Each report asks only for
   * the types it reports on — an income statement must not fail because some
   * unrelated asset account's total left the safe integer range.
   */
  private async netsByType<T extends AccountType>(
    types: readonly T[],
    range: DateRange | undefined,
  ): Promise<Record<T, bigint>> {
    const balances = toBalances(
      await this.repo.accountTotals({
        types: [...types],
        ...(range !== undefined ? { range } : {}),
      }),
    );
    const nets = {} as Record<T, bigint>;
    for (const type of types) {
      nets[type] = aggregateBalances(balances, type);
    }
    return nets;
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
    const nets = await this.netsByType(ALL_ACCOUNT_TYPES, range);
    return (
      nets[AccountType.Asset] -
      (nets[AccountType.Liability] +
        nets[AccountType.Equity] +
        nets[AccountType.Revenue] -
        nets[AccountType.Expense])
    );
  }

  /**
   * The classic trial balance listing: every account with its net balance in
   * the debit or credit column, plus column totals. Equal totals prove the
   * whole ledger balances. Point-in-time (cumulative up to `asOf`).
   */
  async trialBalanceReport(asOf?: Date | string): Promise<TrialBalanceReport> {
    const range = this.parseRange(asOfRange(asOf));
    // One query for the whole listing: per-account sums with awaits between
    // them could interleave with a write and produce a report whose rows come
    // from different ledger states — failing its own balanced check.
    const totals = await this.repo.accountTotals(
      range !== undefined ? { range } : {},
    );
    const rows: TrialBalanceRow[] = [];
    let totalDebits = 0n;
    let totalCredits = 0n;
    for (const { account, credits, debits } of totals) {
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
    const nets = await this.netsByType(ALL_ACCOUNT_TYPES, range);
    const assets = nets[AccountType.Asset];
    const liabilities = nets[AccountType.Liability];
    const equity = nets[AccountType.Equity];
    const revenue = nets[AccountType.Revenue];
    const expenses = nets[AccountType.Expense];
    // Net income (revenue - expenses) is retained earnings, part of equity on
    // a real balance sheet. The residual includes it so the accounting
    // equation holds: Assets = Liabilities + Equity + Net Income.
    const netIncome = revenue - expenses;
    return {
      assets,
      liabilities,
      equity,
      netIncome,
      imbalance: assets - (liabilities + equity + netIncome),
    };
  }

  async incomeStatement(range?: DateRange): Promise<IncomeStatement> {
    const nets = await this.netsByType(
      INCOME_STATEMENT_TYPES,
      this.parseRange(range),
    );
    const revenue = nets[AccountType.Revenue];
    const expenses = nets[AccountType.Expense];
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

  /**
   * The journal in display order — by entry date, then posting sequence,
   * newest first by default. A ledger's journal grows without bound, so pass
   * `page` to window it: `allEntries("desc", { limit: 50 })`, then jump with
   * `offset`.
   *
   * `offset` names a *position*, so a backdated post between two reads
   * reorders the rows underneath the window and a later page can repeat or
   * skip an entry. That is fine for a UI jumping to page 7; when every entry
   * must be seen exactly once, use {@link walkEntries}.
   *
   * `limit`/`offset` must be non-negative integers ({@link ValidationError}
   * otherwise) — a negative limit reaching SQLite means "unbounded", the
   * opposite of what a caller passing one intends.
   */
  async allEntries(
    order: "asc" | "desc" = "desc",
    page: EntryPageOptions = {},
  ): Promise<Entry[]> {
    const parsed = entryPageSchema.safeParse(page);
    if (!parsed.success) {
      throw new ValidationError(
        toIssues(parsed.error.issues),
        "Invalid page options",
      );
    }
    const { limit, offset } = parsed.data ?? {};
    return this.repo.allEntries(order, {
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
  }

  /**
   * The journal in **posting order**, for walking all of it. Continue each
   * page with `after: entryCursor(lastEntryOfThePage)`:
   *
   * ```ts
   * let cursor: EntryCursor | undefined;
   * for (;;) {
   *   const page = await ledger.walkEntries("asc", {
   *     limit: 50,
   *     ...(cursor ? { after: cursor } : {}),
   *   });
   *   const last = page.at(-1);
   *   if (!last) break;
   *   cursor = entryCursor(last);
   * }
   * ```
   *
   * Posting order is the only order in which the journal is append-only, so
   * it is the only one a complete walk can rely on: entries posted or
   * backdated mid-walk take the next sequence number and are visited in turn,
   * and none can appear behind the cursor.
   */
  async walkEntries(
    order: "asc" | "desc" = "desc",
    page: EntryWalkOptions = {},
  ): Promise<Entry[]> {
    const parsed = entryWalkSchema.safeParse(page);
    if (!parsed.success) {
      throw new ValidationError(
        toIssues(parsed.error.issues),
        "Invalid walk options",
      );
    }
    const { limit, after } = parsed.data ?? {};
    return this.repo.walkEntries(order, {
      ...(limit !== undefined ? { limit } : {}),
      ...(after !== undefined ? { after } : {}),
    });
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
