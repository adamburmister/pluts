/** The five account types, mirroring Plutus' single-table-inheritance subclasses. */
export enum AccountType {
  Asset = 'Asset',
  Liability = 'Liability',
  Equity = 'Equity',
  Revenue = 'Revenue',
  Expense = 'Expense',
}

export const ACCOUNT_TYPES: readonly AccountType[] = [
  AccountType.Asset,
  AccountType.Liability,
  AccountType.Equity,
  AccountType.Revenue,
  AccountType.Expense,
];

/**
 * Whether an account type normally has a credit balance.
 * Asset/Expense => debit normal balance (false); others => credit (true).
 */
export function normalCreditBalance(type: AccountType): boolean {
  return (
    type === AccountType.Liability || type === AccountType.Equity || type === AccountType.Revenue
  );
}

/** Optional inclusive date range for balance calculations. Strings are "yyyy-mm-dd". */
export interface DateRange {
  fromDate?: Date | string;
  toDate?: Date | string;
}

/** Normalizes a Date | string to an ISO yyyy-mm-dd string. */
export function toDateISO(d: Date | string): string {
  if (typeof d === 'string') {
    return d;
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
