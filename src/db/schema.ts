import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Pluts D1 schema — the single source of truth for DDL. `db:generate` (via
 * drizzle-kit) turns these table objects into versioned SQL migrations under
 * `./drizzle/`, which are embedded into `src/db/migrations.ts` for the runtime
 * migrator (see `src/db/migrate.ts`).
 *
 * Consumers infer row types via `typeof accounts.$inferSelect` etc. — there are
 * no hand-written row interfaces here.
 *
 * Precision note: D1 returns INTEGER as a JS number. `amount` (minor units) is
 * exact up to Number.MAX_SAFE_INTEGER (~$90T at scale 2), an accepted ceiling
 * for a personal-finance ledger. The write path binds `minor.toString()`.
 */

export const accounts = sqliteTable(
  'pluts_accounts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    contra: integer('contra', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check(
      'pluts_accounts_type_check',
      sql`${t.type} IN ('Asset','Liability','Equity','Revenue','Expense')`,
    ),
    uniqueIndex('pluts_accounts_name_type_idx').on(t.name, t.type),
    index('pluts_accounts_type_idx').on(t.type, t.name),
  ],
);

export const entries = sqliteTable(
  'pluts_entries',
  {
    id: text('id').primaryKey(),
    description: text('description').notNull(),
    date: text('date').notNull(),
    commercialDocumentId: text('commercial_document_id'),
    commercialDocumentType: text('commercial_document_type'),
    postedAt: text('posted_at').notNull(),
  },
  (t) => [
    index('pluts_entries_date_idx').on(t.date),
    index('pluts_entries_commercial_doc_idx').on(t.commercialDocumentId, t.commercialDocumentType),
  ],
);

export const amounts = sqliteTable(
  'pluts_amounts',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    entryId: text('entry_id')
      .notNull()
      .references(() => entries.id),
    amount: integer('amount').notNull(),
  },
  (t) => [
    index('pluts_amounts_type_idx').on(t.type),
    index('pluts_amounts_account_entry_idx').on(t.accountId, t.entryId),
    index('pluts_amounts_entry_account_idx').on(t.entryId, t.accountId),
  ],
);

/**
 * Idempotency keys: a client-supplied dedup key maps to exactly one entry, so
 * retries (e.g. after a Durable Object eviction) return the previously-persisted
 * entry instead of posting a duplicate.
 */
export const entryKeys = sqliteTable('pluts_entry_keys', {
  key: text('key').primaryKey(),
  entryId: text('entry_id')
    .notNull()
    .references(() => entries.id),
});
