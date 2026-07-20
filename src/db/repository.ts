import type { Account } from "../domain/account.js";
import type { Amount } from "../domain/amount.js";
import type { AccountId, EntryId, IdempotencyKey } from "../domain/branded.js";
import type { AmountRecord, Entry, EntryPayload } from "../domain/entry.js";
import { RepositoryError } from "../domain/errors.js";
import type { AccountType, DateRange } from "../domain/types.js";

/**
 * Guard a paging bound: `undefined` (absent) or a non-negative integer.
 * Anything else changes the meaning of the query rather than narrowing it —
 * a negative limit reads as "unbounded" in SQL and drops the last row under
 * JavaScript `slice`. Shared so every {@link Repository} implementation, the
 * test double included, rejects the same inputs.
 */
export function assertPageBound(
  value: number | undefined,
  name: "limit" | "offset",
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RepositoryError(
      `${name} must be a non-negative integer, got ${value}`,
    );
  }
  return value;
}

/**
 * An account paired with its credit and debit totals. Produced by
 * {@link Repository.accountTotals} for every account — an account with no
 * amounts in range reports zero totals rather than being omitted.
 */
export interface AccountTotals {
  account: Account;
  credits: Amount;
  debits: Amount;
}

/** Optional filters for {@link Repository.accountTotals}. */
export interface AccountTotalsOptions {
  /**
   * Restrict to accounts of these types. Omit for every account; an explicit
   * empty list matches no account at all (a filter, not its absence). A report
   * should ask only for the types it reports on: totals it never uses can
   * still fail the safe-integer bridge and take the report down with them.
   */
  types?: AccountType[];
  /** Restrict the summed amounts to entries in this date range. */
  range?: DateRange;
}

/**
 * A position in the journal's **posting order** — the last entry a caller has
 * already seen. Build one with {@link entryCursor}.
 *
 * The position is the journal sequence number, not the entry date. `seq` is
 * assigned monotonically at posting time and never changes, so nothing can
 * ever appear *behind* a cursor: a backdated entry posted mid-walk still gets
 * the next sequence number and is not slotted in among rows already visited.
 * A `(date, seq)` cursor cannot promise that — an entry backdated before the
 * cursor's date would be silently skipped by an ascending walk, which is
 * precisely the guarantee an audit walk needs.
 */
export interface EntryCursor {
  /** The entry's journal sequence number. */
  seq: number;
}

/** Optional windowing for {@link Repository.allEntries}. */
export interface EntryPageOptions {
  /** Maximum number of entries to return. Omit for the whole journal. */
  limit?: number;
  /**
   * Number of entries to skip before collecting. Defaults to 0.
   *
   * `offset` addresses a *position*, so an entry posted or backdated between
   * two page reads shifts the ordering underneath it and the next page can
   * repeat or skip an entry. Fine for a UI jumping to page 7; not for an
   * audit walk that must see every entry exactly once — use
   * {@link Repository.walkEntries}.
   */
  offset?: number;
}

/** Windowing for {@link Repository.walkEntries}. */
export interface EntryWalkOptions {
  /** Maximum number of entries to return. Omit for the rest of the journal. */
  limit?: number;
  /**
   * Continue strictly after this position. Omit to start from the beginning
   * (or, descending, the end) of the journal.
   */
  after?: EntryCursor;
}

/**
 * The cursor identifying an entry's position in the journal — pass the last
 * entry of a page as `after` to fetch the next one.
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
 */
export function entryCursor(entry: Entry): EntryCursor {
  if (entry.seq === null) {
    throw new TypeError(
      "Cannot page from an entry with no journal sequence number (it was never persisted)",
    );
  }
  return { seq: entry.seq };
}

export interface Repository {
  insertAccount(input: {
    name: string;
    type: AccountType;
    contra: boolean;
  }): Promise<Account>;

  getAccount(id: AccountId): Promise<Account | null>;
  getAccountByName(name: string): Promise<Account | null>;
  getAccountsByType(type: AccountType): Promise<Account[]>;
  allAccounts(): Promise<Account[]>;

  /**
   * Persist an entry (and its amounts) atomically. Returns the persisted
   * entry. Implementations MUST call `assertBalanced(payload)` before writing:
   * `EntryPayload` is structurally constructible, so the double-entry
   * invariant (≥1 debit, ≥1 credit, sum(debits) === sum(credits), total > 0)
   * has to be enforced at this seam, not only in the `Ledger` facade.
   */
  insertEntry(payload: EntryPayload): Promise<Entry>;

  getEntry(id: EntryId): Promise<Entry | null>;
  /**
   * Journal sequence stats: total number of entries and the highest assigned
   * sequence number. With gap-free monotonic numbering these are equal; a
   * difference indicates entries missing between surviving rows (a contiguous
   * tail truncation shifts both together and is not detectable from these).
   */
  entrySequenceStats(): Promise<{ count: number; maxSeq: number }>;
  /** Look up an entry by its client-supplied idempotency key, or null if none. */
  getEntryByKey(key: IdempotencyKey): Promise<Entry | null>;
  /**
   * Look up an idempotency-key record: the entry it maps to plus the payload
   * fingerprint recorded at posting time (empty string for rows written
   * before fingerprints existed). Used to distinguish a genuine retry
   * (fingerprints match) from a key collision (fingerprints differ).
   */
  getEntryKeyRecord(
    key: IdempotencyKey,
  ): Promise<{ entryId: EntryId; payloadHash: string } | null>;
  /**
   * The journal in display order — by entry date, then posting sequence,
   * newest first by default. Pass `page` to window the result: a full
   * ledger's journal is unbounded, and every returned entry costs hydration
   * work.
   *
   * This listing is for *display*. Paging through it with `offset` cannot
   * promise to visit every entry exactly once, because a backdated post
   * reorders the rows underneath the window — use {@link walkEntries} when
   * completeness matters.
   */
  allEntries(order?: "asc" | "desc", page?: EntryPageOptions): Promise<Entry[]>;

  /**
   * The journal in **posting order** (`seq`), for walking it completely.
   * Continue with `after: entryCursor(lastEntryOfThePage)`.
   *
   * Posting order is the only order in which the journal is append-only, so
   * it is the only one a walk can rely on: no entry, however it is dated, can
   * ever appear behind the cursor, so a walk never repeats or skips a row.
   *
   * Direction decides what a mid-walk posting means:
   * - `"asc"` — an open-ended walk. Entries posted while it runs take higher
   *   sequence numbers, so they are visited in turn and the walk sees the
   *   journal *including* everything written during it.
   * - `"desc"` — a fixed-tail walk. Entries posted while it runs take higher
   *   sequence numbers, i.e. land behind the starting point, and are not
   *   visited. The walk covers exactly the journal as of its first page.
   */
  walkEntries(
    order?: "asc" | "desc",
    page?: EntryWalkOptions,
  ): Promise<Entry[]>;

  /** Sum of credit amounts for an account, optionally within a date range. */
  sumCredits(accountId: AccountId, range?: DateRange): Promise<Amount>;
  /** Sum of debit amounts for an account, optionally within a date range. */
  sumDebits(accountId: AccountId, range?: DateRange): Promise<Amount>;

  /**
   * Credit and debit totals for every account (optionally filtered by account
   * type), gathered in a **single** query.
   *
   * Reports must read all accounts from one consistent view of the ledger.
   * Summing account-by-account puts an `await` between the sums, and a write
   * landing in that gap yields a report whose rows describe different ledger
   * states — a trial balance that fails its own balanced check on a healthy
   * ledger. One query is one atomic read.
   */
  accountTotals(options?: AccountTotalsOptions): Promise<AccountTotals[]>;

  /** Sum of amounts of a given kind across all accounts of a type, optionally within a date range. */
  sumByType(
    type: AccountType,
    kind: "credit" | "debit",
    range?: DateRange,
  ): Promise<Amount>;

  /** All amounts (credit + debit) for an account, with their entries. */
  amountsForAccount(accountId: AccountId): Promise<AmountRecord[]>;
  /** All entries referencing an account (via credit or debit amounts). */
  entriesForAccount(accountId: AccountId): Promise<Entry[]>;
}
