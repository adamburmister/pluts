import type { SqlStorage } from "@cloudflare/workers-types";
import { SCALE } from "../domain/amount";
import { RepositoryError } from "../domain/errors";

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
  FOREIGN KEY (entry_id) REFERENCES pluts_entries(id) ON UPDATE no action ON DELETE no action
)`,
  // Self-description (audit findings F-07/F-10): the stored integers are
  // meaningless without the scale (and ideally currency) they denominate, and
  // schema evolution needs a recorded version. Without this, bumping SCALE
  // would silently reinterpret every stored amount, and a mixed-currency
  // routing bug would be undetectable from the data.
  META_TABLE_DDL,
];

/**
 * Version of the Pluts schema this build of the library expects. Recorded in
 * `pluts_ledger_meta` under `schema_version` by {@link migrate}. Databases
 * provisioned before the meta table existed are treated as version 0 and
 * stamped on their next migrate (all DDL is idempotent `IF NOT EXISTS`, so
 * 0 -> 1 needs no data steps). Future incompatible changes bump this constant
 * and add explicit upgrade steps to `migrate` — never "reset the database".
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

  // Older stored versions were upgraded by the DDL above (versioned data
  // steps go before this stamp as the schema evolves) and are now advanced;
  // 0 -> 1 needs no data steps because all v1 DDL is idempotent. Newer
  // stored versions were rejected before any DDL ran.
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
