import type { Account } from "../domain/account";
import type { Amount } from "../domain/amount";
import type { AmountRecord, Entry, EntryPayload } from "../domain/entry";
import type { AccountType, DateRange } from "../domain/types";

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
  allEntries(order?: "asc" | "desc"): Promise<Entry[]>;

  /** Sum of credit amounts for an account, optionally within a date range. */
  sumCredits(accountId: string, range?: DateRange): Promise<Amount>;
  /** Sum of debit amounts for an account, optionally within a date range. */
  sumDebits(accountId: string, range?: DateRange): Promise<Amount>;

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
