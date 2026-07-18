import type { Account } from "./account.js";
import type { Amount } from "./amount.js";
import {
  type AmountLineDTO,
  type EntryDTO,
  toAmountLineDTO,
  toEntryDTO,
} from "./dto.js";
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
  /**
   * True when {@link date} was defaulted to "today" because the caller
   * omitted it. Excludes the resolved date from the idempotency fingerprint
   * so a date-less retry still matches after a UTC day rollover. Not
   * persisted.
   */
  readonly dateWasDefaulted?: true;
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

  /**
   * Serialize via the DTO mapper so there is exactly one wire shape for a
   * line, whether it is stringified alone or inside an {@link Entry}.
   */
  toJSON(): AmountLineDTO {
    return toAmountLineDTO(this);
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
    /**
     * Monotonic journal number, assigned at posting time (1, 2, 3, …).
     * Gives entries a citable identity ("JE 142"), makes same-date ordering
     * deterministic, and lets MAX(seq) === COUNT(*) prove completeness.
     * Null only for domain objects constructed outside a repository.
     */
    readonly seq: number | null = null,
  ) {
    // `readonly T[]` is compile-time only; freeze so a runtime push on a
    // posted entry throws instead of silently mutating the object.
    Object.freeze(debitAmounts);
    Object.freeze(creditAmounts);
  }

  /** Serialize via the DTO mapper — one wire shape (see {@link toEntryDTO}). */
  toJSON(): EntryDTO {
    return toEntryDTO(this);
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
    ...(parsed.data.date === undefined ? { dateWasDefaulted: true } : {}),
  };
  return payload;
}

/**
 * Compute a stable fingerprint of an entry payload's business content:
 * SHA-256 (hex) over description, date, and the ordered debit/credit lines
 * (account id + minor units). Stored beside the idempotency key so a retry
 * can be told apart from a key collision: identical fingerprint => genuine
 * retry (return the original entry); different fingerprint => client bug
 * (throw {@link IdempotencyConflictError} rather than silently dropping the
 * second transaction).
 *
 * The date is hashed as the *caller* supplied it — `null` when it was
 * defaulted — so a date-less retry fingerprints identically even after a UTC
 * day rollover.
 */
export async function computeEntryFingerprint(
  payload: EntryPayload,
): Promise<string> {
  const canonical = JSON.stringify({
    description: payload.description,
    date: payload.dateWasDefaulted ? null : payload.date,
    debits: payload.debits.map((l) => [
      l.account.id,
      l.amount.minor.toString(),
    ]),
    credits: payload.credits.map((l) => [
      l.account.id,
      l.amount.minor.toString(),
    ]),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
