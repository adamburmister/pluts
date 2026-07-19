import type { SqlStorage } from "@cloudflare/workers-types";
import { SCALE } from "../domain/amount.js";
import { RepositoryError } from "../domain/errors.js";

/**
 * Pluts schema — the single source of truth for DDL, applied to a
 * SQLite-backed Durable Object's own storage (`ctx.storage.sql`).
 *
 * Precision note: `SqlStorage` returns INTEGER as a JS number. `amount` (minor
 * units) is exact up to Number.MAX_SAFE_INTEGER (~$90T at scale 2), an accepted
 * ceiling for a personal-finance ledger. The write path binds
 * `Number(amount.minor)`.
 */

/**
 * DDL for the metadata table alone. `migrate` applies this (and reads the
 * stored schema version) BEFORE the rest of {@link SCHEMA_STATEMENTS}: a
 * build older than the stored version must refuse without executing DDL
 * written for a schema a newer release may have reshaped.
 */
const META_TABLE_DDL = `CREATE TABLE IF NOT EXISTS pluts_ledger_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`;

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
  seq INTEGER NOT NULL,
  CONSTRAINT pluts_entries_date_check CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date) IS NOT NULL AND date(date) = date)
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
  CONSTRAINT pluts_amounts_type_check CHECK (type IN ('debit','credit')),
  CONSTRAINT pluts_amounts_amount_check CHECK (typeof(amount) = 'integer' AND amount >= 0 AND amount <= 9007199254740991),
  FOREIGN KEY (account_id) REFERENCES pluts_accounts(id) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (entry_id) REFERENCES pluts_entries(id) ON UPDATE no action ON DELETE no action
)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_type_idx ON pluts_amounts (type)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_account_entry_idx ON pluts_amounts (account_id, entry_id)`,
  `CREATE INDEX IF NOT EXISTS pluts_amounts_entry_account_idx ON pluts_amounts (entry_id, account_id)`,
  // payload_hash carries the SHA-256 payload fingerprint the dedup path
  // compares strictly — an empty hash would make the key conflict forever,
  // even for genuine retries, so the schema refuses to store one (no
  // DEFAULT: raw SQL omitting the column is rejected too).
  `CREATE TABLE IF NOT EXISTS pluts_entry_keys (
  key TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash != ''),
  FOREIGN KEY (entry_id) REFERENCES pluts_entries(id) ON UPDATE no action ON DELETE no action
)`,
  // Self-description (audit findings F-07/F-10): the stored integers are
  // meaningless without the scale (and ideally currency) they denominate, and
  // schema evolution needs a recorded version. Without this, bumping SCALE
  // would silently reinterpret every stored amount, and a mixed-currency
  // routing bug would be undetectable from the data.
  META_TABLE_DDL,

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
 * Version of the Pluts schema this build of the library expects. Recorded in
 * `pluts_ledger_meta` under `schema_version` by {@link migrate}. A freshly
 * provisioned database reads as version 0 until its first migrate stamps it.
 * Future incompatible changes bump this constant and add explicit upgrade
 * steps to `migrate` — never "reset the database".
 */
export const SCHEMA_VERSION = 1;

/** Metadata describing a provisioned ledger database. */
export interface LedgerMeta {
  /** ISO-4217-style currency code the ledger's amounts denominate, if stamped. */
  currency?: string;
  /** Decimal scale the stored minor units were written at. */
  scale: number;
  /** Schema version last stamped by {@link migrate}. */
  schemaVersion: number;
}

/** Read the ledger's recorded metadata. Requires {@link migrate} to have run. */
export function getLedgerMeta(sql: SqlStorage): LedgerMeta {
  const rows = sql
    .exec("SELECT key, value FROM pluts_ledger_meta")
    .toArray() as Array<{ key?: unknown; value?: unknown }>;
  const map = new Map(rows.map((r) => [String(r.key), String(r.value)]));
  const currency = map.get("currency");
  return {
    ...(currency !== undefined ? { currency } : {}),
    scale: Number(map.get("scale") ?? SCALE),
    schemaVersion: Number(map.get("schema_version") ?? 0),
  };
}

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
export function migrate(
  sql: SqlStorage,
  opts: { currency?: string } = {},
): void {
  // Rollback guard FIRST, before any other DDL: a newer release may have
  // reshaped tables that this build's statements still reference, so a build
  // older than the stored schema_version must refuse before executing any of
  // them. Only the meta table (stable across versions by contract) is
  // created ahead of the check.
  sql.exec(META_TABLE_DDL).toArray();
  const meta = getLedgerMeta(sql);
  if (meta.schemaVersion > SCHEMA_VERSION) {
    throw new RepositoryError(
      `Ledger schema is version ${meta.schemaVersion} but this build supports up to ${SCHEMA_VERSION}; ` +
        "deploy a build at or above the stored version instead of rolling back",
    );
  }

  for (const stmt of SCHEMA_STATEMENTS) {
    sql.exec(stmt).toArray();
  }

  // Stamp and verify the ledger's self-description. The scale check is the
  // guard that makes SCALE bumps safe: a ledger written at scale 2 opened by
  // a build compiled at scale 3 would silently reinterpret every stored
  // amount 10x smaller — refuse loudly and demand an explicit rescale
  // migration instead.

  const stamp = (key: string, value: string) => {
    sql
      .exec(
        "INSERT OR IGNORE INTO pluts_ledger_meta (key, value) VALUES (?, ?)",
        key,
        value,
      )
      .toArray();
  };

  const stampedScale = sql
    .exec("SELECT value FROM pluts_ledger_meta WHERE key = 'scale'")
    .toArray() as Array<{ value?: unknown }>;
  if (stampedScale.length > 0 && meta.scale !== SCALE) {
    throw new RepositoryError(
      `Ledger was written at scale ${meta.scale} but this build uses scale ${SCALE}; ` +
        "run a rescale migration on stored minor units before opening it",
    );
  }
  stamp("scale", String(SCALE));

  // Stamp the current schema version. As the schema evolves, versioned data
  // steps run against the DDL above before this stamp; newer stored versions
  // were already rejected by the rollback guard before any DDL ran.
  sql
    .exec(
      "INSERT INTO pluts_ledger_meta (key, value) VALUES ('schema_version', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(SCHEMA_VERSION),
    )
    .toArray();

  // Trim before the truthiness check: a whitespace-only configured currency
  // must read as "not provided", not permanently stamp a blank denomination
  // that the mismatch guard can never catch.
  const currency = opts.currency?.trim();
  if (currency) {
    if (meta.currency && meta.currency !== currency) {
      throw new RepositoryError(
        `Ledger is denominated in ${meta.currency}; refusing to open it as ${currency}`,
      );
    }
    stamp("currency", currency);
  }
}
