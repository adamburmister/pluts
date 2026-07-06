import type { D1Database } from '@cloudflare/workers-types';
import { accounts, amounts, entries } from './schema.js';

/**
 * Idempotently creates the Pluts tables and indexes on a D1 database.
 * Mirrors the Ruby migration `20160422010135_create_plutus_tables.rb`.
 */
export async function migrate(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS pluts_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        contra INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS pluts_accounts_name_type_idx ON pluts_accounts (name, type)`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS pluts_accounts_type_idx ON pluts_accounts (type, name)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS pluts_entries (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        date TEXT NOT NULL,
        commercial_document_id TEXT,
        commercial_document_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS pluts_entries_date_idx ON pluts_entries (date)`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS pluts_entries_commercial_doc_idx
        ON pluts_entries (commercial_document_id, commercial_document_type)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS pluts_amounts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES pluts_accounts(id),
        entry_id TEXT NOT NULL REFERENCES pluts_entries(id),
        amount INTEGER NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS pluts_amounts_type_idx ON pluts_amounts (type)`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS pluts_amounts_account_entry_idx ON pluts_amounts (account_id, entry_id)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS pluts_amounts_entry_account_idx ON pluts_amounts (entry_id, account_id)`,
    ),
    // Backfill the type column rename (pre-refactor values were the Ruby STI
    // class names 'CreditAmount'/'DebitAmount'); idempotent no-ops on new DBs.
    db.prepare(`UPDATE pluts_amounts SET type = 'credit' WHERE type = 'CreditAmount'`),
    db.prepare(`UPDATE pluts_amounts SET type = 'debit' WHERE type = 'DebitAmount'`),
  ]);
}

// Re-export schema for drizzle-kit / consumers.
export { accounts, amounts, entries };
