import type { SqlStorage } from "@cloudflare/workers-types";

/**
 * Pluts schema — the single source of truth for DDL, applied to a
 * SQLite-backed Durable Object's own storage (`ctx.storage.sql`).
 *
 * Precision note: `SqlStorage` returns INTEGER as a JS number. `amount` (minor
 * units) is exact up to Number.MAX_SAFE_INTEGER (~$90T at scale 2), an accepted
 * ceiling for a personal-finance ledger. The write path binds
 * `Number(amount.minor)`.
 */

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS pluts_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  contra INTEGER DEFAULT 0 NOT NULL,
  created_at TEXT NOT NULL,
  CONSTRAINT pluts_accounts_type_check CHECK (type IN ('Asset','Liability','Equity','Revenue','Expense'))
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS pluts_accounts_name_type_idx ON pluts_accounts (name, type)`,
  `CREATE INDEX IF NOT EXISTS pluts_accounts_type_idx ON pluts_accounts (type, name)`,
  `CREATE TABLE IF NOT EXISTS pluts_entries (
  id TEXT PRIMARY KEY NOT NULL,
  description TEXT NOT NULL,
  date TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  CONSTRAINT pluts_entries_date_check CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
)`,
  `CREATE INDEX IF NOT EXISTS pluts_entries_date_idx ON pluts_entries (date)`,
  `CREATE TABLE IF NOT EXISTS pluts_amounts (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  CONSTRAINT pluts_amounts_type_check CHECK (type IN ('debit','credit')),
  CONSTRAINT pluts_amounts_amount_check CHECK (typeof(amount) = 'integer' AND amount >= 0),
  FOREIGN KEY (account_id) REFERENCES pluts_accounts(id) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (entry_id) REFERENCES pluts_entries(id) ON UPDATE no action ON DELETE no action
)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_type_idx ON pluts_amounts (type)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_account_entry_idx ON pluts_amounts (account_id, entry_id)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_entry_account_idx ON pluts_amounts (entry_id, account_id)`,
  `CREATE TABLE IF NOT EXISTS pluts_entry_keys (
  key TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES pluts_entries(id) ON UPDATE no action ON DELETE no action
)`,

  // ------------------------------------------------------------------
  // Append-only enforcement (audit finding F-04).
  //
  // Posted entries are the financial record: corrections happen via
  // reversing entries, never UPDATE/DELETE. The library itself issues no
  // mutations, but the consumer's Durable Object holds the raw SqlStorage
  // handle, so the tables must defend themselves — a stray UPDATE from
  // application code aborts instead of silently rewriting closed periods.
  //
  // The entries UPDATE trigger is column-scoped to the financial fields so
  // that future non-financial housekeeping columns (added by later
  // migrations) remain backfillable; amounts and idempotency keys are
  // immutable in full. Note: trigger bodies contain internal semicolons —
  // runners that naively split SCHEMA_SQL on ';' will corrupt them; use
  // migrate(), which executes each statement whole.
  `CREATE TRIGGER IF NOT EXISTS pluts_entries_no_update
  BEFORE UPDATE OF id, description, date, posted_at ON pluts_entries
  BEGIN SELECT RAISE(ABORT, 'pluts: ledger entries are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_entries_no_delete
  BEFORE DELETE ON pluts_entries
  BEGIN SELECT RAISE(ABORT, 'pluts: ledger entries are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_amounts_no_update
  BEFORE UPDATE ON pluts_amounts
  BEGIN SELECT RAISE(ABORT, 'pluts: ledger amounts are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_amounts_no_delete
  BEFORE DELETE ON pluts_amounts
  BEGIN SELECT RAISE(ABORT, 'pluts: ledger amounts are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_entry_keys_no_update
  BEFORE UPDATE ON pluts_entry_keys
  BEGIN SELECT RAISE(ABORT, 'pluts: idempotency keys are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_entry_keys_no_delete
  BEFORE DELETE ON pluts_entry_keys
  BEGIN SELECT RAISE(ABORT, 'pluts: idempotency keys are append-only'); END`,

  // ------------------------------------------------------------------
  // Row-validity enforcement (audit finding F-14).
  //
  // The CREATE TABLE CHECK constraints above only apply to freshly created
  // databases — SQLite cannot retrofit a CHECK onto an existing table. These
  // INSERT triggers enforce the same rules on already-provisioned databases,
  // so a row written by non-library SQL is rejected loudly instead of being
  // silently excluded from every WHERE type = 'debit'/'credit' aggregate.
  `CREATE TRIGGER IF NOT EXISTS pluts_amounts_validate_insert
  BEFORE INSERT ON pluts_amounts
  WHEN NEW.type NOT IN ('debit','credit')
    OR typeof(NEW.amount) != 'integer'
    OR NEW.amount < 0
  BEGIN SELECT RAISE(ABORT, 'pluts: amount rows require type debit|credit and a non-negative integer amount'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_entries_validate_insert
  BEFORE INSERT ON pluts_entries
  WHEN NEW.date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  BEGIN SELECT RAISE(ABORT, 'pluts: entry date must be a yyyy-mm-dd string'); END`,
];

/**
 * The full Pluts schema as a single SQL string (statements joined with `;\n`),
 * for inspection or for runtimes whose `exec` splits on `;`. To apply it to a
 * Durable Object's storage, prefer {@link migrate}, which runs each
 * statement individually via `SqlStorage.exec` (robust across runtimes).
 */
export const SCHEMA_SQL: string = SCHEMA_STATEMENTS.map((s) => `${s};`).join(
  "\n",
);

/**
 * Apply the Pluts schema to a SQLite-backed Durable Object's own storage
 * (`ctx.storage.sql`). Idempotent: a database already at the latest schema is a
 * no-op. `SqlStorage.exec` runs synchronously against the DO's embedded SQLite
 * with no network round-trip, so it is safe to call from the DO constructor
 * inside `blockConcurrencyWhile` — the recommended place to provision storage
 * before any request is served.
 *
 * ```ts
 * import { migrate } from 'pluts';
 *
 * export class LedgerDO extends DurableObject {
 *   constructor(ctx, env) {
 *     super(ctx, env);
 *     ctx.blockConcurrencyWhile(() => { migrate(ctx.storage.sql); return Promise.resolve(); });
 *   }
 * }
 * ```
 */
export function migrate(sql: SqlStorage): void {
  for (const stmt of SCHEMA_STATEMENTS) {
    sql.exec(stmt).toArray();
  }
}
