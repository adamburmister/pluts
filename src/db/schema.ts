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
  CONSTRAINT pluts_entries_date_check CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date) IS NOT NULL AND date(date) = date)
)`,
  `CREATE INDEX IF NOT EXISTS pluts_entries_date_idx ON pluts_entries (date)`,
  `CREATE TABLE IF NOT EXISTS pluts_amounts (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  CONSTRAINT pluts_amounts_type_check CHECK (type IN ('debit','credit')),
  CONSTRAINT pluts_amounts_amount_check CHECK (typeof(amount) = 'integer' AND amount >= 0 AND amount <= 9007199254740991),
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
  // The trigger above is column-scoped so future migration columns stay
  // backfillable — but UPDATE OF never matches a rowid assignment, so
  // "UPDATE ... SET rowid = -1" slipped past it and poisoned the
  // auto-rowid sentinel the no_replace guards rely on. This companion
  // trigger fires on every UPDATE and aborts only when the rowid changes.
  `CREATE TRIGGER IF NOT EXISTS pluts_entries_no_rowid_update
  BEFORE UPDATE ON pluts_entries
  WHEN NEW.rowid != OLD.rowid
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

  // INSERT OR REPLACE bypasses the DELETE triggers above: with SQLite's
  // default recursive_triggers = OFF, conflict resolution deletes the
  // existing row WITHOUT firing them, then inserts the replacement — a
  // silent rewrite path. BEFORE INSERT triggers fire before conflict
  // resolution, so an existence guard on the conflict channels closes it.
  // These are rowid tables, so REPLACE can conflict on rowid as well as the
  // TEXT primary key; both are guarded. For auto-assigned rowids NEW.rowid
  // is -1 in a BEFORE INSERT trigger, which matches no real row, so normal
  // inserts pass.
  `CREATE TRIGGER IF NOT EXISTS pluts_entries_no_replace
  BEFORE INSERT ON pluts_entries
  WHEN EXISTS (SELECT 1 FROM pluts_entries WHERE id = NEW.id)
    OR EXISTS (SELECT 1 FROM pluts_entries WHERE rowid = NEW.rowid)
  BEGIN SELECT RAISE(ABORT, 'pluts: ledger entries are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_amounts_no_replace
  BEFORE INSERT ON pluts_amounts
  WHEN EXISTS (SELECT 1 FROM pluts_amounts WHERE id = NEW.id)
    OR EXISTS (SELECT 1 FROM pluts_amounts WHERE rowid = NEW.rowid)
  BEGIN SELECT RAISE(ABORT, 'pluts: ledger amounts are append-only'); END`,
  // The message must still read as a unique-constraint failure: the
  // repository's concurrent-post recovery path string-matches
  // "UNIQUE constraint failed" when two posts race on the same key.
  `CREATE TRIGGER IF NOT EXISTS pluts_entry_keys_no_replace
  BEFORE INSERT ON pluts_entry_keys
  WHEN EXISTS (SELECT 1 FROM pluts_entry_keys WHERE key = NEW.key)
    OR EXISTS (SELECT 1 FROM pluts_entry_keys WHERE rowid = NEW.rowid)
  BEGIN SELECT RAISE(ABORT, 'pluts: UNIQUE constraint failed: pluts_entry_keys.key is append-only'); END`,

  // The guards above read NEW.rowid = -1 as "auto-assigned" (its BEFORE
  // INSERT sentinel value), so a real row stored at a negative rowid would
  // make the sentinel match an existing row and abort every ordinary insert.
  // AFTER INSERT sees the actually-assigned rowid — always positive for
  // auto-assignment — so rejecting negatives here makes the poisoned state
  // unstorable without touching normal inserts.
  `CREATE TRIGGER IF NOT EXISTS pluts_entries_no_negative_rowid
  AFTER INSERT ON pluts_entries
  WHEN NEW.rowid < 0
  BEGIN SELECT RAISE(ABORT, 'pluts: negative rowid values are reserved'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_amounts_no_negative_rowid
  AFTER INSERT ON pluts_amounts
  WHEN NEW.rowid < 0
  BEGIN SELECT RAISE(ABORT, 'pluts: negative rowid values are reserved'); END`,
  `CREATE TRIGGER IF NOT EXISTS pluts_entry_keys_no_negative_rowid
  AFTER INSERT ON pluts_entry_keys
  WHEN NEW.rowid < 0
  BEGIN SELECT RAISE(ABORT, 'pluts: negative rowid values are reserved'); END`,

  // ------------------------------------------------------------------
  // Row-validity enforcement (audit finding F-14).
  //
  // The CREATE TABLE CHECK constraints above only apply to freshly created
  // databases — SQLite cannot retrofit a CHECK onto an existing table. These
  // INSERT triggers enforce the same rules on already-provisioned databases,
  // so a row written by non-library SQL is rejected loudly instead of being
  // silently excluded from every WHERE type = 'debit'/'credit' aggregate.
  // The 9007199254740991 ceiling is Number.MAX_SAFE_INTEGER: larger values
  // store fine as SQLite 64-bit integers but cannot cross the SqlStorage
  // JS-number boundary on read, so every later read/SUM would throw.
  `CREATE TRIGGER IF NOT EXISTS pluts_amounts_validate_insert
  BEFORE INSERT ON pluts_amounts
  WHEN NEW.type NOT IN ('debit','credit')
    OR typeof(NEW.amount) != 'integer'
    OR NEW.amount < 0
    OR NEW.amount > 9007199254740991
  BEGIN SELECT RAISE(ABORT, 'pluts: amount rows require type debit|credit and a non-negative integer amount within the JS safe-integer range'); END`,
  // The GLOB checks shape only; date() round-tripping checks the calendar:
  // SQLite normalizes 2026-02-30 to 2026-03-02 (breaking equality) and
  // returns NULL for out-of-range fields like month 13.
  `CREATE TRIGGER IF NOT EXISTS pluts_entries_validate_insert
  BEFORE INSERT ON pluts_entries
  WHEN NEW.date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR date(NEW.date) IS NULL
    OR date(NEW.date) != NEW.date
  BEGIN SELECT RAISE(ABORT, 'pluts: entry date must be a valid yyyy-mm-dd calendar date'); END`,
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
  // Repair legacy negative rowids BEFORE creating the triggers: databases
  // provisioned without the append-only guards can already hold rows at
  // rowid -1 (or other negatives). The no_replace guards read NEW.rowid = -1
  // as "auto-assigned", so such a row would make every ordinary insert abort
  // — and once the UPDATE triggers exist, the rowid can no longer be
  // repaired. Reassignment is safe: nothing references rowid (all FKs use
  // the TEXT ids), and this window predates the triggers.
  for (const table of ["pluts_entries", "pluts_amounts", "pluts_entry_keys"]) {
    const exists = sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      )
      .toArray();
    if (exists.length === 0) continue;
    const negatives = sql
      .exec(`SELECT rowid FROM ${table} WHERE rowid < 0 ORDER BY rowid ASC`)
      .toArray() as Array<{ rowid?: unknown }>;
    for (const row of negatives) {
      sql
        .exec(
          `UPDATE ${table} SET rowid = (SELECT MAX(0, COALESCE(MAX(rowid), 0)) + 1 FROM ${table}) WHERE rowid = ?`,
          Number(row.rowid),
        )
        .toArray();
    }
  }

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
