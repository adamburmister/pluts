import type { Account } from "./account.js";
import type { AmountRecord, Entry } from "./entry.js";
import type { AccountType } from "./types.js";

/**
 * Plain, boundary-safe projections of the pluts domain objects.
 *
 * The pluts domain types (Account, AmountRecord, Entry) carry `class`
 * instances and `bigint` values, which cannot cross the two exits from a
 * Durable Object: Workers RPC (structured clone rejects class instances) and
 * JSON REST (JSON.stringify throws on bigint). These mappers produce deep-plain
 * objects whose monetary fields are fixed-precision decimal strings, suitable
 * for both. Use them at every RPC/REST boundary; never return a raw domain
 * object across one.
 */

export interface AccountDTO {
  id: string;
  name: string;
  type: AccountType;
  contra: boolean;
  createdAt: string;
  /** Optional pre-computed balance, formatted in major units. */
  balance?: string;
}

export interface AmountLineDTO {
  id: string;
  kind: "debit" | "credit";
  account: AccountDTO;
  /** Major-units decimal string, e.g. "10.00". */
  amount: string;
  entryId: string;
}

export interface EntryDTO {
  id: string;
  description: string;
  date: string;
  /** Monotonic journal number; null for entries built outside a repository. */
  seq: number | null;
  debitAmounts: AmountLineDTO[];
  creditAmounts: AmountLineDTO[];
  postedAt: string;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

export function toAccountDTO(account: Account): AccountDTO {
  return freeze({
    id: account.id,
    name: account.name,
    type: account.type,
    contra: account.contra,
    createdAt: account.createdAt,
  });
}

export function toAmountLineDTO(line: AmountRecord): AmountLineDTO {
  return freeze({
    id: line.id,
    kind: line.kind,
    account: toAccountDTO(line.account),
    amount: line.amount.toMajor(),
    entryId: line.entryId,
  });
}

export function toEntryDTO(entry: Entry): EntryDTO {
  return freeze({
    id: entry.id,
    description: entry.description,
    date: entry.date,
    seq: entry.seq,
    debitAmounts: entry.debitAmounts.map(toAmountLineDTO),
    creditAmounts: entry.creditAmounts.map(toAmountLineDTO),
    postedAt: entry.postedAt,
  });
}
