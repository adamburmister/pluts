import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Custom Drizzle column storing an {@link Amount} as an INTEGER of minor units.
 *
 * D1 INTEGER is returned as a JS number, which is exact for amounts up to
 * Number.MAX_SAFE_INTEGER minor units (~$90T at scale 2). For a personal
 * finance ledger this is ample; documented as a known ceiling.
 */

export interface AccountRow {
  id: string;
  name: string;
  type: string;
  contra: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntryRow {
  id: string;
  description: string;
  date: string;
  commercialDocumentId: string | null;
  commercialDocumentType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AmountRow {
  id: string;
  type: string;
  accountId: string;
  entryId: string;
  amount: number;
}

export const accounts = sqliteTable('pluts_accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  contra: integer('contra').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const entries = sqliteTable('pluts_entries', {
  id: text('id').primaryKey(),
  description: text('description').notNull(),
  date: text('date').notNull(),
  commercialDocumentId: text('commercial_document_id'),
  commercialDocumentType: text('commercial_document_type'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const amounts = sqliteTable('pluts_amounts', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id),
  entryId: text('entry_id')
    .notNull()
    .references(() => entries.id),
  amount: integer('amount').notNull(),
});
