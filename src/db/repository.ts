import type { Account } from '../domain/account.js';
import type { Amount } from '../domain/amount.js';
import type { AmountRecord, Entry, EntryPayload } from '../domain/entry.js';
import type { AccountType, DateRange } from '../domain/types.js';

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

  /** Validate and persist an entry (and its amounts) atomically. Returns the persisted entry. */
  insertEntry(payload: EntryPayload): Promise<Entry>;

  getEntry(id: string): Promise<Entry | null>;
  allEntries(order?: 'asc' | 'desc'): Promise<Entry[]>;

  /** Sum of credit amounts for an account, optionally within a date range. */
  sumCredits(accountId: string, range?: DateRange): Promise<Amount>;
  /** Sum of debit amounts for an account, optionally within a date range. */
  sumDebits(accountId: string, range?: DateRange): Promise<Amount>;

  /** Sum of amounts of a given kind across all accounts of a type, optionally within a date range. */
  sumByType(type: AccountType, kind: 'credit' | 'debit', range?: DateRange): Promise<Amount>;

  /** All amounts (credit + debit) for an account, with their entries. */
  amountsForAccount(accountId: string): Promise<AmountRecord[]>;
  /** All entries referencing an account (via credit or debit amounts). */
  entriesForAccount(accountId: string): Promise<Entry[]>;
}
