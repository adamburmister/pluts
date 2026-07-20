import type { Amount } from "./amount.js";
import type { AccountId, ISODate } from "./branded.js";
import { type AccountType, normalCreditBalance } from "./types.js";

/**
 * Canonical key for account-name matching. Account names are trimmed at
 * creation and lookup, then matched case-insensitively.
 */
export function accountNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * A persisted account record. The `type` discriminates the accounting
 * behaviour. `id` is an {@link AccountId} and `createdAt` an {@link ISODate} —
 * both branded so an account id cannot be passed where a date (or any other
 * identifier) is expected. Construct one only from a repository; the brand is
 * the repository's say-so that this id came from the ledger.
 */
export class Account {
  constructor(
    readonly id: AccountId,
    readonly name: string,
    readonly type: AccountType,
    readonly contra: boolean,
    readonly createdAt: ISODate,
  ) {}
}

/**
 * Compute an account's balance from its summed credit and debit totals.
 *
 * Mirrors Plutus `Account#balance`:
 * - normal credit balance, non-contra => credits - debits
 * - normal credit balance, contra     => debits - credits
 * - normal debit balance, non-contra  => debits - credits
 * - normal debit balance, contra      => credits - debits
 *
 * Returns a raw signed `bigint` (may be negative; balances normally are not).
 * The non-negative {@link Amount} type cannot represent a negative balance, so
 * balance math stays in `bigint`; format for display with {@link formatAmount}.
 */
export function computeBalance(
  type: AccountType,
  contra: boolean,
  credits: Amount,
  debits: Amount,
): bigint {
  const creditNormal = normalCreditBalance(type);
  // creditNormal XOR contra => credits - debits; else debits - credits
  if (creditNormal !== contra) {
    return credits.minor - debits.minor;
  }
  return debits.minor - credits.minor;
}

/**
 * Aggregate a set of account balances by type, subtracting contra accounts.
 * Mirrors the Ruby class-level `Account.balance` (e.g. `Plutus::Asset.balance`).
 * Balances are signed `bigint`; the result is signed `bigint`.
 */
export function aggregateBalances(
  accounts: ReadonlyArray<{
    type: AccountType;
    contra: boolean;
    balance: bigint;
  }>,
  type: AccountType,
): bigint {
  let total = 0n;
  for (const a of accounts) {
    if (a.type !== type) continue;
    total += a.contra ? -a.balance : a.balance;
  }
  return total;
}
