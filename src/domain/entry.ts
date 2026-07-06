import { type Account } from './account.js';
import { Amount } from './amount.js';
import { ValidationError, type ValidationIssue } from './errors.js';
import { type AmountLine, type EntryInput, entryInputSchema, toIssues } from './schemas.js';
import { type CommercialDocumentRef, toDateISO } from './types.js';

export type AmountKind = 'credit' | 'debit';

/** A debit/credit line with a resolved account (no name lookup pending). */
export interface ResolvedAmountLine {
  readonly account: Account;
  readonly amount: Amount;
}

/**
 * A validated, unpersisted entry: description, date, document, and resolved
 * debit/credit lines (each carrying an `Account` and an `Amount`). Has no id;
 * persistence assigns one. Immutable.
 */
export interface EntryPayload {
  readonly description: string;
  readonly date: string;
  readonly commercialDocument: CommercialDocumentRef | null;
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
}

/**
 * A persisted journal entry: one or more debits and credits that balance.
 * Immutable; constructed fully-formed with assigned ids and timestamps.
 */
export class Entry {
  constructor(
    readonly id: string,
    readonly description: string,
    readonly date: string,
    readonly commercialDocument: CommercialDocumentRef | null,
    readonly debitAmounts: readonly AmountRecord[],
    readonly creditAmounts: readonly AmountRecord[],
    readonly createdAt: string,
    readonly updatedAt: string,
  ) {}
}

function newId(): string {
  return crypto.randomUUID();
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
  const { description, commercialDocument, debits, credits } = parsed.data;
  const date = parsed.data.date ?? toDateISO(now());

  // Resolve accounts by name (post-parse). Unresolved names become issues.
  const issues: ValidationIssue[] = [];
  const resolveLine = (
    line: AmountLine,
    index: number,
    root: 'debits' | 'credits',
  ): ResolvedAmountLine | null => {
    if (line.account) return { account: line.account, amount: line.amount };
    const name = line.accountName;
    if (name) {
      const found = resolveAccount(name);
      if (found) return { account: found, amount: line.amount };
      issues.push({
        path: [root, index, 'account'],
        message: `Account "${name}" not found`,
      });
    }
    return null;
  };

  const resolvedDebits: ResolvedAmountLine[] = [];
  const resolvedCredits: ResolvedAmountLine[] = [];
  debits.forEach((l, i) => {
    const r = resolveLine(l, i, 'debits');
    if (r) resolvedDebits.push(r);
  });
  credits.forEach((l, i) => {
    const r = resolveLine(l, i, 'credits');
    if (r) resolvedCredits.push(r);
  });

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }

  return {
    description,
    date,
    commercialDocument: commercialDocument ?? null,
    debits: resolvedDebits,
    credits: resolvedCredits,
  };
}

/** Build {@link AmountRecord}s from a payload, assigning fresh ids. */
export function amountsFromPayload(
  payload: EntryPayload,
  entryId: string,
): { debits: AmountRecord[]; credits: AmountRecord[] } {
  return {
    debits: payload.debits.map(
      (l) => new AmountRecord(newId(), 'debit', l.account, l.amount, entryId),
    ),
    credits: payload.credits.map(
      (l) => new AmountRecord(newId(), 'credit', l.account, l.amount, entryId),
    ),
  };
}
