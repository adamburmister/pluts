import type { Account } from "../domain/account.js";
import type { Amount } from "../domain/amount.js";
import type { AmountRecord, Entry, EntryPayload } from "../domain/entry.js";
import type { AccountType, DateRange } from "../domain/types.js";

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

/** Optional windowing for {@link Repository.allEntries}. */
export interface EntryPageOptions {
  /** Maximum number of entries to return. Omit for the whole journal. */
  limit?: number;
  /** Number of entries to skip before collecting. Defaults to 0. */
  offset?: number;
}

export interface Repository {
  insertAccount(input: {
    name: string;
    type: AccountType;
    contra: boolean;
  }): Promise<Account>;

  getAccount(id: string): Promise<Account | null>;
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

  getEntry(id: string): Promise<Entry | null>;
  /**
   * Journal sequence stats: total number of entries and the highest assigned
   * sequence number. With gap-free monotonic numbering these are equal; a
   * difference indicates entries missing between surviving rows (a contiguous
   * tail truncation shifts both together and is not detectable from these).
   */
  entrySequenceStats(): Promise<{ count: number; maxSeq: number }>;
  /** Look up an entry by its client-supplied idempotency key, or null if none. */
  getEntryByKey(key: string): Promise<Entry | null>;
  /**
   * Look up an idempotency-key record: the entry it maps to plus the payload
   * fingerprint recorded at posting time (empty string for rows written
   * before fingerprints existed). Used to distinguish a genuine retry
   * (fingerprints match) from a key collision (fingerprints differ).
   */
  getEntryKeyRecord(
    key: string,
  ): Promise<{ entryId: string; payloadHash: string } | null>;
  /**
   * The journal, newest first by default. Pass `page` to window the result —
   * a full ledger's journal is unbounded, and every returned entry costs
   * hydration work.
   */
  allEntries(order?: "asc" | "desc", page?: EntryPageOptions): Promise<Entry[]>;

  /** Sum of credit amounts for an account, optionally within a date range. */
  sumCredits(accountId: string, range?: DateRange): Promise<Amount>;
  /** Sum of debit amounts for an account, optionally within a date range. */
  sumDebits(accountId: string, range?: DateRange): Promise<Amount>;

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
  amountsForAccount(accountId: string): Promise<AmountRecord[]>;
  /** All entries referencing an account (via credit or debit amounts). */
  entriesForAccount(accountId: string): Promise<Entry[]>;
}
