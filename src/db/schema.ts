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
  // Account names are unique per ledger across ALL types. A (name, type)
  // uniqueness would let two accounts share a name (e.g. an Asset "Cash" and a
  // Liability "Cash"), making name-based entry posting ambiguous — the amount
  // would land on whichever row the lookup happened to return first.
  `CREATE UNIQUE INDEX IF NOT EXISTS pluts_accounts_name_idx ON pluts_accounts (name)`,
  `CREATE INDEX IF NOT EXISTS pluts_accounts_type_idx ON pluts_accounts (type, name)`,
  `CREATE TABLE IF NOT EXISTS pluts_entries (
  id TEXT PRIMARY KEY NOT NULL,
  description TEXT NOT NULL,
  date TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  seq INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS pluts_entries_date_idx ON pluts_entries (date)`,
  // Journal numbering (audit finding F-08): a journal is a chronological,
  // *numbered* record. seq is assigned monotonically at insert (MAX(seq)+1
  // inside the posting transaction — safe under the DO single-writer model),
  // giving citable entry numbers, deterministic (date, seq) ordering, and a
  // one-query gap check: MAX(seq) = COUNT(*) iff no entry is missing between
  // surviving rows (tail truncation needs an external high-water mark).
  `CREATE UNIQUE INDEX IF NOT EXISTS pluts_entries_seq_idx ON pluts_entries (seq)`,
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
  // Legacy upgrade, before the DDL loop so the seq unique index can be
  // created: databases provisioned before journal numbering lack the seq
  // column (CREATE TABLE IF NOT EXISTS skips them). ALTER TABLE is not
  // idempotent, so probe via table_info (an allowed pragma in DO SQL
  // storage).
  const entryColumns = sql
    .exec("PRAGMA table_info(pluts_entries)")
    .toArray() as Array<{ name?: unknown }>;
  if (entryColumns.length > 0 && !entryColumns.some((c) => c.name === "seq")) {
    sql.exec("ALTER TABLE pluts_entries ADD COLUMN seq INTEGER").toArray();
  }

  for (const stmt of SCHEMA_STATEMENTS) {
    sql.exec(stmt).toArray();
  }

  // Backfill unnumbered rows on every migrate, not only when the column was
  // just added: a deploy interrupted between ALTER TABLE and the backfill
  // leaves NULLs behind a "column already exists" guard forever. Numbering
  // continues from the highest existing seq (new rows may have been posted
  // since the interruption, so rowid alone could collide) in rowid order —
  // insertion order, which is posting order (the library never deletes).
  const maxRow = sql
    .exec("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM pluts_entries")
    .toArray() as Array<{ max_seq?: unknown }>;
  let nextSeq = Number(maxRow[0]?.max_seq ?? 0);
  const unnumbered = sql
    .exec("SELECT id FROM pluts_entries WHERE seq IS NULL ORDER BY rowid ASC")
    .toArray() as Array<{ id?: unknown }>;
  for (const row of unnumbered) {
    nextSeq += 1;
    sql
      .exec(
        "UPDATE pluts_entries SET seq = ? WHERE id = ?",
        nextSeq,
        String(row.id),
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
