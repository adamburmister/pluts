import { z } from "zod";
import { Account } from "./account";
import { Amount } from "./amount";
import type { ValidationIssue } from "./errors";
import { AccountType, isValidISODate, toDateISO } from "./types";

/**
 * Amount input: accepts an already-built {@link Amount}, a non-negative finite
 * number, or a digit-only string. The transform parses raw values to an
 * `Amount` via half-up rounding at the supported scale, so float imprecision
 * (e.g. `0.1 + 0.2`) is resolved at the input boundary. Stored values stay
 * exact integers.
 *
 * `z.custom<Amount>` (rather than `z.instanceof(Amount)`) is used because
 * {@link Amount} has a private constructor and Zod v4's `z.instanceof`
 * requires a public one. `amountLineSchema` below uses `z.instanceof(Account)`
 * because `Account`'s constructor is public.
 */
export const amountSchema = z
  .union([
    z.custom<Amount>((v) => v instanceof Amount, { message: "Invalid Amount" }),
    z.number().finite().nonnegative(),
    z.string().regex(/^\d+(\.\d+)?$/),
  ])
  .transform((v, ctx) => {
    if (v instanceof Amount) return v;
    // Amount.fromMajor throws RangeError on values its digit parser cannot
    // represent (e.g. 1e21 stringifies in exponential notation). Schema
    // transforms must never throw raw errors — report a Zod issue so callers
    // get the promised path-tagged ValidationError.
    try {
      return Amount.fromMajor(v);
    } catch (e) {
      ctx.addIssue({
        code: "custom",
        message: e instanceof Error ? e.message : "Invalid amount",
      });
      return z.NEVER;
    }
  });

/**
 * A `Date | string` normalized to a strict ISO `yyyy-mm-dd` string. String
 * inputs must be zero-padded, calendar-valid ISO dates: range queries compare
 * dates lexicographically, so any other format silently mis-buckets the entry
 * in period reports (F-02).
 */
const isoDateSchema = z
  .union([
    z.date(),
    z.string().refine(isValidISODate, {
      message: "must be a valid yyyy-mm-dd date",
    }),
  ])
  .transform(toDateISO);

/** Optional inclusive date range, normalized to ISO strings. */
export const dateRangeSchema = z
  .object({
    fromDate: isoDateSchema.optional(),
    toDate: isoDateSchema.optional(),
  })
  .optional();

/** Input for account creation. `name` is trimmed; `contra` defaults to false. */
export const createAccountSchema = z.object({
  name: z.string().trim().min(1),
  type: z.nativeEnum(AccountType),
  contra: z.boolean().default(false),
});

export type CreateAccountInput = z.input<typeof createAccountSchema>;

/** A single debit/credit line. Either `account` or `accountName` is required. */
const amountLineSchema = z
  .object({
    account: z.instanceof(Account).optional(),
    accountName: z.string().min(1).optional(),
    amount: amountSchema,
  })
  .refine((v) => v.account || v.accountName, {
    message: "can't be blank",
    path: ["account"],
  });

export type AmountLine = z.output<typeof amountLineSchema>;
export type AmountInput = z.input<typeof amountLineSchema>;

/** Input shape for building an entry (mirrors Ruby's `Entry.new` hash). */
export const entryInputSchema = z
  .object({
    idempotencyKey: z.string().min(1).optional(),
    description: z.string().min(1),
    date: isoDateSchema.optional(),
    debits: z.array(amountLineSchema),
    credits: z.array(amountLineSchema),
  })
  .superRefine((v, ctx) => {
    if (v.debits.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["debits"],
        message: "Entry must have at least one debit amount",
      });
    }
    if (v.credits.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["credits"],
        message: "Entry must have at least one credit amount",
      });
    }
    // Only reconcile totals once every line parsed to an `Amount`. If a line's
    // amount failed the union (e.g. a negative number), its per-line issue
    // already explains the failure, and summing the raw value here would throw
    // `TypeError: Cannot mix BigInt and other types` — turning a clean
    // validation failure into a crash (and `safeParse` must never throw).
    const amounts = [...v.debits, ...v.credits].map((l) => l.amount);
    if (amounts.every((a) => a instanceof Amount)) {
      const debitSum = v.debits.reduce((acc, l) => acc + l.amount.minor, 0n);
      const creditSum = v.credits.reduce((acc, l) => acc + l.amount.minor, 0n);
      if (debitSum !== creditSum) {
        ctx.addIssue({
          code: "custom",
          path: [],
          message: "The credit and debit amounts are not equal",
        });
      } else if (debitSum === 0n) {
        ctx.addIssue({
          code: "custom",
          path: [],
          message: "Entry amounts must be greater than zero",
        });
      }
    }
  });

export type EntryInput = z.input<typeof entryInputSchema>;

/**
 * Maps Zod issues to {@link ValidationIssue}s, preserving paths.
 */
export function toIssues(zodIssues: z.ZodIssue[]): ValidationIssue[] {
  return zodIssues.map((i) => ({ path: i.path, message: i.message }));
}
