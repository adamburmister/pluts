import { Amount } from './amount.js';
import { type AccountType, normalCreditBalance } from './types.js';

/** A persisted account record. The `type` discriminates the accounting behaviour. */
export class Account {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly type: AccountType,
    readonly contra: boolean,
    readonly createdAt: string,
    readonly updatedAt: string,
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
 * The result is a signed Amount (may be negative; balances normally are not).
 */
export function computeBalance(
  type: AccountType,
  contra: boolean,
  credits: Amount,
  debits: Amount,
): Amount {
  const creditNormal = normalCreditBalance(type);
  // creditNormal XOR contra => credits - debits; else debits - credits
  if (creditNormal !== contra) {
    return Amount.fromSigned(credits.signed() - debits.signed());
  }
  return Amount.fromSigned(debits.signed() - credits.signed());
}

/**
 * Aggregate a set of account balances by type, subtracting contra accounts.
 * Mirrors the Ruby class-level `Account.balance` (e.g. `Plutus::Asset.balance`).
 */
export function aggregateBalances(
  accounts: ReadonlyArray<{ type: AccountType; contra: boolean; balance: Amount }>,
  type: AccountType,
): Amount {
  let total = 0n;
  for (const a of accounts) {
    if (a.type !== type) continue;
    total += a.contra ? -a.balance.signed() : a.balance.signed();
  }
  return Amount.fromSigned(total);
}
