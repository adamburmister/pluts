import type { D1Database } from '@cloudflare/workers-types';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { Account } from '../domain/account.js';
import { Amount } from '../domain/amount.js';
import {
  type AmountKind,
  AmountRecord,
  Entry,
  type EntryPayload,
  amountsFromPayload,
} from '../domain/entry.js';
import { RepositoryError, ValidationError } from '../domain/errors.js';
import {
  type AccountType,
  type CommercialDocumentRef,
  type DateRange,
  toDateISO,
} from '../domain/types.js';
import type { Repository } from './repository.js';
import { accounts, amounts, entries, entryKeys } from './schema.js';

type AccountRow = typeof accounts.$inferSelect;
type EntryRow = typeof entries.$inferSelect;
type AmountRow = typeof amounts.$inferSelect;

/** Flat entry-column selection for queries that join other tables. */
const entrySelection = {
  id: entries.id,
  description: entries.description,
  date: entries.date,
  commercialDocumentId: entries.commercialDocumentId,
  commercialDocumentType: entries.commercialDocumentType,
  postedAt: entries.postedAt,
};

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * D1 surfaces constraint violations as objects with a `message` property
 * containing "UNIQUE constraint failed" (case-insensitive). There is no typed
 * error class, so this string-matches the message. Drizzle propagates the same
 * D1 error object, so the match still fires through the query-builder path.
 */
export function isUniqueConstraintError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('message' in e)) return false;
  return /UNIQUE constraint failed/i.test(String((e as { message: unknown }).message));
}

function toAccount(row: AccountRow): Account {
  return new Account(row.id, row.name, row.type as AccountType, row.contra, row.createdAt);
}

function dateRangeWhere(range: DateRange | undefined): ReturnType<typeof and> | undefined {
  if (!range) return undefined;
  const parts = [];
  if (range.fromDate) parts.push(gte(entries.date, toDateISO(range.fromDate)));
  if (range.toDate) parts.push(lte(entries.date, toDateISO(range.toDate)));
  return parts.length ? and(...parts) : undefined;
}

export class D1Repository implements Repository {
  private readonly db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  async insertAccount(input: {
    name: string;
    type: AccountType;
    contra: boolean;
  }): Promise<Account> {
    const id = uuid();
    const now = new Date().toISOString();
    try {
      await this.db
        .insert(accounts)
        .values({
          id,
          name: input.name,
          type: input.type,
          contra: input.contra,
          createdAt: now,
        })
        .run();
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new ValidationError(
          [{ path: ['name'], message: 'has already been taken' }],
          'Account already exists',
        );
      }
      throw e;
    }
    return new Account(id, input.name, input.type, input.contra, now);
  }

  async getAccount(id: string): Promise<Account | null> {
    const row = await this.db.select().from(accounts).where(eq(accounts.id, id)).get();
    return row ? toAccount(row) : null;
  }

  async getAccountByName(name: string): Promise<Account | null> {
    const row = await this.db.select().from(accounts).where(eq(accounts.name, name)).get();
    return row ? toAccount(row) : null;
  }

  async getAccountsByType(type: AccountType): Promise<Account[]> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.type, type))
      .orderBy(asc(accounts.name))
      .all();
    return rows.map(toAccount);
  }

  async allAccounts(): Promise<Account[]> {
    const rows = await this.db.select().from(accounts).orderBy(asc(accounts.name)).all();
    return rows.map(toAccount);
  }

  async insertEntry(payload: EntryPayload): Promise<Entry> {
    const id = uuid();
    const now = new Date().toISOString();
    const doc = payload.commercialDocument;
    const { debits, credits } = amountsFromPayload(payload, id);

    const entryStmt = this.db.insert(entries).values({
      id,
      description: payload.description,
      date: payload.date,
      commercialDocumentId: doc?.id ?? null,
      commercialDocumentType: doc?.type ?? null,
      postedAt: now,
    });

    const amountStmts = [...debits, ...credits].map((a) =>
      this.db.insert(amounts).values({
        id: a.id,
        type: a.kind,
        accountId: a.account.id,
        entryId: id,
        amount: Number(a.amount.minor),
      }),
    );

    // Persist the idempotency key in the same atomic batch so a retry that
    // races with the key insert can never leave a keyless duplicate entry.
    const keyStmts = payload.idempotencyKey
      ? [this.db.insert(entryKeys).values({ key: payload.idempotencyKey, entryId: id })]
      : [];

    try {
      await this.db.batch([entryStmt, ...amountStmts, ...keyStmts]);
    } catch (e) {
      // Two concurrent posts sharing an idempotency key can race past the
      // pre-check in Ledger.postEntry; the loser's key insert hits the unique
      // constraint. Recover by returning the already-persisted entry.
      if (payload.idempotencyKey && isUniqueConstraintError(e)) {
        const existing = await this.getEntryByKey(payload.idempotencyKey);
        if (existing) return existing;
      }
      throw new RepositoryError('Failed to persist entry', e);
    }

    return new Entry(id, payload.description, payload.date, doc, debits, credits, now);
  }

  async getEntry(id: string): Promise<Entry | null> {
    const row = await this.db.select().from(entries).where(eq(entries.id, id)).get();
    if (!row) return null;
    return this.loadEntry(row);
  }

  async getEntryByKey(key: string): Promise<Entry | null> {
    const row = await this.db
      .select(entrySelection)
      .from(entries)
      .innerJoin(entryKeys, eq(entryKeys.entryId, entries.id))
      .where(eq(entryKeys.key, key))
      .get();
    if (!row) return null;
    return this.loadEntry(row);
  }

  async allEntries(order: 'asc' | 'desc' = 'desc'): Promise<Entry[]> {
    const rows = await this.db
      .select()
      .from(entries)
      .orderBy(order === 'asc' ? asc(entries.date) : desc(entries.date))
      .all();
    return Promise.all(rows.map((r) => this.loadEntry(r)));
  }

  async sumCredits(accountId: string, range?: DateRange): Promise<Amount> {
    return this.sumAmounts(accountId, 'credit', range);
  }

  async sumDebits(accountId: string, range?: DateRange): Promise<Amount> {
    return this.sumAmounts(accountId, 'debit', range);
  }

  async sumByType(type: AccountType, kind: AmountKind, range?: DateRange): Promise<Amount> {
    const r = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${amounts.amount}), 0)` })
      .from(amounts)
      .innerJoin(accounts, eq(accounts.id, amounts.accountId))
      .innerJoin(entries, eq(entries.id, amounts.entryId))
      .where(and(eq(accounts.type, type), eq(amounts.type, kind), dateRangeWhere(range)))
      .get();
    return Amount.fromMinor(BigInt(r?.total ?? 0));
  }

  async amountsForAccount(accountId: string): Promise<AmountRecord[]> {
    const rows = await this.db
      .select()
      .from(amounts)
      .where(eq(amounts.accountId, accountId))
      .orderBy(asc(amounts.entryId))
      .all();
    return this.hydrateAmounts(rows);
  }

  async entriesForAccount(accountId: string): Promise<Entry[]> {
    const rows = await this.db
      .selectDistinct(entrySelection)
      .from(entries)
      .innerJoin(amounts, eq(amounts.entryId, entries.id))
      .where(eq(amounts.accountId, accountId))
      .orderBy(desc(entries.date))
      .all();
    return Promise.all(rows.map((r) => this.loadEntry(r)));
  }

  private async sumAmounts(
    accountId: string,
    kind: AmountKind,
    range?: DateRange,
  ): Promise<Amount> {
    const r = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${amounts.amount}), 0)` })
      .from(amounts)
      .innerJoin(entries, eq(entries.id, amounts.entryId))
      .where(and(eq(amounts.accountId, accountId), eq(amounts.type, kind), dateRangeWhere(range)))
      .get();
    return Amount.fromMinor(BigInt(r?.total ?? 0));
  }

  /** Builds a fully-formed immutable Entry from a row, loading its amounts. */
  private async loadEntry(row: EntryRow): Promise<Entry> {
    const rows = await this.db.select().from(amounts).where(eq(amounts.entryId, row.id)).all();
    const records = await this.hydrateAmounts(rows);
    const debits = records.filter((r) => r.kind === 'debit');
    const credits = records.filter((r) => r.kind === 'credit');
    const doc =
      row.commercialDocumentId && row.commercialDocumentType
        ? ({
            id: row.commercialDocumentId,
            type: row.commercialDocumentType,
          } as CommercialDocumentRef)
        : null;
    return new Entry(row.id, row.description, row.date, doc, debits, credits, row.postedAt);
  }

  private async hydrateAmounts(rows: AmountRow[]): Promise<AmountRecord[]> {
    if (rows.length === 0) return [];
    const accountIds = [...new Set(rows.map((r) => r.accountId))];
    const accountRows = await this.db
      .select()
      .from(accounts)
      .where(inArray(accounts.id, accountIds))
      .all();
    const accountMap = new Map(accountRows.map((r) => [r.id, toAccount(r)]));
    return rows.map((r) => {
      const account = accountMap.get(r.accountId);
      if (!account) throw new Error(`Missing account ${r.accountId} for amount ${r.id}`);
      return new AmountRecord(
        r.id,
        r.type as AmountKind,
        account,
        Amount.fromMinor(BigInt(r.amount)),
        r.entryId,
      );
    });
  }
}
