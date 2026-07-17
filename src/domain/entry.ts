import type { Account } from "./account.js";
import type { Amount } from "./amount.js";
import { ValidationError, type ValidationIssue } from "./errors.js";
import {
  type AmountLine,
  type EntryInput,
  entryInputSchema,
  toIssues,
} from "./schemas.js";
import { toDateISO } from "./types.js";

export type AmountKind = "credit" | "debit";

/** A debit/credit line with a resolved account (no name lookup pending). */
export interface ResolvedAmountLine {
  readonly account: Account;
  readonly amount: Amount;
}

/**
 * A validated, unpersisted entry: description, date, and resolved debit/credit
 * lines (each carrying an `Account` and an `Amount`). Has no id; persistence
 * assigns one. Immutable. Carries an optional client-supplied
 * {@link idempotencyKey} so the repository can dedup retries atomically.
 */
export interface EntryPayload {
  readonly idempotencyKey?: string;
  readonly description: string;
  readonly date: string;
  readonly debits: readonly ResolvedAmountLine[];
  readonly credits: readonly ResolvedAmountLine[];
}

/**
 * A persisted debit or credit leg of an entry. Immutable.
 */
export class AmountRecord {
  constructor(
    readonly id: string,
    readonly kind: AmountKind,
    readonly account: Account,
    readonly amount: Amount,
    readonly entryId: string,
  ) {}

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      kind: this.kind,
      accountId: this.account.id,
      amount: this.amount.toMajor(),
      entryId: this.entryId,
    };
  }
}

/**
 * A persisted journal entry: one or more debits and credits that balance.
 * Immutable; constructed fully-formed with an assigned id and a posted-at
 * timestamp (when it was recorded). The `date` field is the transaction date
 * (when the economic event occurred) — kept distinct from `postedAt` for audit
 * clarity.
 */
export class Entry {
  constructor(
    readonly id: string,
    readonly description: string,
    readonly date: string,
    readonly debitAmounts: readonly AmountRecord[],
    readonly creditAmounts: readonly AmountRecord[],
    readonly postedAt: string,
  ) {}

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      description: this.description,
      date: this.date,
      debitAmounts: this.debitAmounts.map((d) => ({
        ...d,
        amount: d.amount.toMajor(),
      })),
      creditAmounts: this.creditAmounts.map((c) => ({
        ...c,
        amount: c.amount.toMajor(),
      })),
      postedAt: this.postedAt,
    };
  }
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Assert the double-entry invariant on a payload about to be persisted:
 * at least one debit, at least one credit, sum(debits) === sum(credits),
 * and a non-zero total. Throws {@link ValidationError} otherwise.
 *
 * {@link buildEntry} already enforces this via the input schema, but
 * {@link EntryPayload} is a structural interface — nothing stops a caller
 * (or a third-party Repository port) from hand-constructing an unbalanced
 * payload and passing it straight to `insertEntry`. Every `Repository`
 * implementation MUST call this before persisting; the invariant belongs to
 * the persistence seam, not just the input facade.
 */
export function assertBalanced(payload: EntryPayload): void {
  const issues: ValidationIssue[] = [];
  if (payload.debits.length === 0) {
    issues.push({
      path: ["debits"],
      message: "Entry must have at least one debit amount",
    });
  }
  if (payload.credits.length === 0) {
    issues.push({
      path: ["credits"],
      message: "Entry must have at least one credit amount",
    });
  }
  const debitSum = payload.debits.reduce((acc, l) => acc + l.amount.minor, 0n);
  const creditSum = payload.credits.reduce(
    (acc, l) => acc + l.amount.minor,
    0n,
  );
  if (debitSum !== creditSum) {
    issues.push({
      path: [],
      message: "The credit and debit amounts are not equal",
    });
  } else if (debitSum === 0n && issues.length === 0) {
    issues.push({
      path: [],
      message: "Entry amounts must be greater than zero",
    });
  }
  if (issues.length > 0) {
    throw new ValidationError(issues, "Unbalanced entry");
  }
}

/**
 * Validate input and assemble an {@link EntryPayload}. Throws
 * {@link ValidationError} on failure with a flat list of path-tagged issues.
 *
 * Validation:
 * - shape and per-line rules via {@link entryInputSchema} (Zod)
 * - entry-level invariants (≥1 debit, ≥1 credit, debits-sum === credits-sum)
 *   via the schema's `superRefine`
 * - account-name resolution happens *after* schema validation (DB lookups
 *   aren't schema concerns); unresolved accounts are reported as issues
 *   with path `[root, index, 'account']`
 *
 * @param resolveAccount looks up an account by name; returns null if missing
 */
export function buildEntry(
  input: EntryInput,
  resolveAccount: (name: string) => Account | null = () => null,
  now: () => Date = () => new Date(),
): EntryPayload {
  const parsed = entryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(toIssues(parsed.error.issues));
  }
  const { description, debits, credits } = parsed.data;
  const date = parsed.data.date ?? toDateISO(now());
  const { idempotencyKey } = parsed.data;

  // Resolve accounts by name (post-parse). Unresolved names become issues.
  const issues: ValidationIssue[] = [];
  const resolveLine = (
    line: AmountLine,
    index: number,
    root: "debits" | "credits",
  ): ResolvedAmountLine | null => {
    if (line.account) return { account: line.account, amount: line.amount };
    const name = line.accountName;
    if (name) {
      const found = resolveAccount(name);
      if (found) return { account: found, amount: line.amount };
      issues.push({
        path: [root, index, "account"],
        message: `Account "${name}" not found`,
      });
    }
    return null;
  };

  const resolvedDebits: ResolvedAmountLine[] = [];
  const resolvedCredits: ResolvedAmountLine[] = [];
  debits.forEach((l, i) => {
    const r = resolveLine(l, i, "debits");
    if (r) resolvedDebits.push(r);
  });
  credits.forEach((l, i) => {
    const r = resolveLine(l, i, "credits");
    if (r) resolvedCredits.push(r);
  });

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }

  const payload: EntryPayload = {
    description,
    date,
    debits: resolvedDebits,
    credits: resolvedCredits,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  return payload;
}

/** Build {@link AmountRecord}s from a payload, assigning fresh ids. */
export function amountsFromPayload(
  payload: EntryPayload,
  entryId: string,
): { debits: AmountRecord[]; credits: AmountRecord[] } {
  return {
    debits: payload.debits.map(
      (l) => new AmountRecord(newId(), "debit", l.account, l.amount, entryId),
    ),
    credits: payload.credits.map(
      (l) => new AmountRecord(newId(), "credit", l.account, l.amount, entryId),
    ),
  };
}
