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
  posted_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS pluts_entries_date_idx ON pluts_entries (date)`,
  `CREATE TABLE IF NOT EXISTS pluts_amounts (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES pluts_accounts(id) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (entry_id) REFERENCES pluts_entries(id) ON UPDATE no action ON DELETE no action
)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_type_idx ON pluts_amounts (type)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_account_entry_idx ON pluts_amounts (account_id, entry_id)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_entry_account_idx ON pluts_amounts (entry_id, account_id)`,
  `CREATE TABLE IF NOT EXISTS pluts_entry_keys (
  key TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (entry_id) REFERENCES pluts_entries(id) ON UPDATE no action ON DELETE no action
)`,
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
  // Databases provisioned before payload fingerprints existed lack the
  // payload_hash column (CREATE TABLE IF NOT EXISTS skips them). ALTER TABLE
  // is not idempotent, so probe first via table_info — an allowed pragma in
  // Durable Object SQL storage. Legacy key rows keep the '' default, which
  // the dedup path treats as "no recorded fingerprint" (match anything), so
  // retries of pre-upgrade postings keep working.
  const keyColumns = sql
    .exec("PRAGMA table_info(pluts_entry_keys)")
    .toArray() as Array<{ name?: unknown }>;
  if (!keyColumns.some((c) => c.name === "payload_hash")) {
    sql
      .exec(
        "ALTER TABLE pluts_entry_keys ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''",
      )
      .toArray();
  }
}
