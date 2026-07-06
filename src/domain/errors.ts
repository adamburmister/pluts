/**
 * A single validation issue. `path` follows Zod's convention: an array of
 * property keys / indices locating the offending field within the input.
 * Record-level invariants (e.g. "debit and credit totals must cancel") use
 * an empty path `[]`.
 */
export interface ValidationIssue {
  path: PropertyKey[];
  message: string;
}

/**
 * Thrown when a domain operation (e.g. posting an entry, creating an account)
 * fails validation. Carries a flat list of {@link ValidationIssue}s rather than
 * an ActiveRecord-style field-keyed map, preserving path precision (you can tell
 * *which* debit's amount was bad).
 */
export class ValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[], message = 'Validation failed') {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }

  /**
   * Collapses issue paths to a field-keyed map for form binding.
   * - Issues with an empty path go under `'_base'`.
   * - Otherwise the root key of the path is used (e.g. `['debits', 0, 'account']` → `'account'`).
   *
   * Note: this loses path precision (which array index). Use `issues` directly
   * when you need that.
   */
  errorsByField(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const issue of this.issues) {
      const key = issue.path.length === 0 ? '_base' : String(issue.path[0]);
      const list = out[key];
      if (list) {
        list.push(issue.message);
      } else {
        out[key] = [issue.message];
      }
    }
    return out;
  }
}
