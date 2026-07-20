/** The five account types, mirroring Plutus' single-table-inheritance subclasses. */
export enum AccountType {
  Asset = "Asset",
  Liability = "Liability",
  Equity = "Equity",
  Revenue = "Revenue",
  Expense = "Expense",
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
    type === AccountType.Liability ||
    type === AccountType.Equity ||
    type === AccountType.Revenue
  );
}

/** Optional inclusive date range for balance calculations. Strings are "yyyy-mm-dd". */
export interface DateRange {
  fromDate?: Date | string;
  toDate?: Date | string;
}

/**
 * Whether a string is a strict, zero-padded `yyyy-mm-dd` calendar date.
 *
 * Entry dates are compared *lexicographically* in range queries (SQL
 * `date >= ?` on TEXT columns), which is only correct for strictly
 * zero-padded ISO strings. Anything else (`"2026-1-5"`, `"not-a-date"`)
 * would silently land in the wrong reporting period, so malformed dates
 * must never reach storage.
 */
export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * The library's default "today": the **UTC** calendar day.
 *
 * Every date in Pluts is a bare `yyyy-mm-dd` calendar date with no attached
 * offset, so "today" is only well-defined relative to a chosen zone, and the
 * chosen zone here is UTC. For any zone east of UTC (AUD/NZD, UTC+8..+13)
 * an entry posted before local noon defaults to *yesterday* — which at a
 * month boundary silently moves it into the previous reporting period.
 *
 * Consumers that need a local calendar day should pass
 * {@link todayInTimeZone} as the `Ledger`'s `today` option, or supply an
 * explicit `date` on every entry.
 */
export function utcToday(at: Date = new Date()): string {
  return toDateISO(at);
}

/**
 * Builds a "today" function for an IANA time zone, for use as the `Ledger`
 * `today` option: `new Ledger(repo, { today: todayInTimeZone("Pacific/Auckland") })`.
 *
 * Throws `RangeError` immediately for an unknown zone, so a typo fails at
 * construction rather than silently defaulting dates to UTC at posting time.
 */
export function todayInTimeZone(timeZone: string): (at?: Date) => string {
  // `en-CA` formats as yyyy-mm-dd, zero-padded, which is exactly our shape.
  // Constructing eagerly is what surfaces an invalid zone as a RangeError.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (at: Date = new Date()) => {
    const formatted = formatter.format(at);
    if (!isValidISODate(formatted)) {
      throw new RangeError(
        `Time zone ${timeZone} produced a non-ISO date: ${formatted}`,
      );
    }
    return formatted;
  };
}

/**
 * Normalizes a Date | string to an ISO yyyy-mm-dd string.
 * Throws RangeError on malformed strings or invalid Dates; public API paths
 * validate first via Zod (see `isoDateSchema`), so this throw is the
 * defense-in-depth backstop for direct repository use.
 */
export function toDateISO(d: Date | string): string {
  if (typeof d === "string") {
    if (!isValidISODate(d)) {
      throw new RangeError(`Invalid ISO date string: ${d}`);
    }
    return d;
  }
  if (Number.isNaN(d.getTime())) {
    throw new RangeError("Invalid Date");
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
