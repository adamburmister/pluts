import type { D1Database } from '@cloudflare/workers-types';
import { Account } from '../domain/account.js';
import { Amount } from '../domain/amount.js';
import {
  type AmountKind,
  AmountRecord,
  Entry,
  type EntryPayload,
  amountsFromPayload,
} from '../domain/entry.js';
import {
  type AccountType,
  type CommercialDocumentRef,
  type DateRange,
  toDateISO,
} from '../domain/types.js';
import type { Repository } from './repository.js';

interface AccountRow {
  id: string;
  name: string;
  type: string;
  contra: number;
  created_at: string;
  updated_at: string;
}
interface EntryRow {
  id: string;
  description: string;
  date: string;
  commercial_document_id: string | null;
  commercial_document_type: string | null;
  created_at: string;
  updated_at: string;
}
interface AmountRow {
  id: string;
  type: string;
  account_id: string;
  entry_id: string;
  amount: number;
}

function uuid(): string {
  return crypto.randomUUID();
}

function toAccount(row: AccountRow): Account {
  return new Account(
    row.id,
    row.name,
    row.type as AccountType,
    row.contra !== 0,
    row.created_at,
    row.updated_at,
  );
}

function dateRangeClause(
  range: DateRange | undefined,
  prefix = '',
): { clause: string; params: unknown[] } {
  if (!range) return { clause: '', params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  if (range.fromDate) {
    parts.push(`${prefix}date >= ?`);
    params.push(toDateISO(range.fromDate));
  }
  if (range.toDate) {
    parts.push(`${prefix}date <= ?`);
    params.push(toDateISO(range.toDate));
  }
  return parts.length ? { clause: `AND (${parts.join(' AND ')})`, params } : { clause: '', params };
}

export class D1Repository implements Repository {
  constructor(private readonly db: D1Database) {}

  async insertAccount(input: {
    name: string;
    type: AccountType;
    contra: boolean;
  }): Promise<Account> {
    const id = uuid();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO pluts_accounts (id, name, type, contra, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.name, input.type, input.contra ? 1 : 0, now, now)
      .run();
    return new Account(id, input.name, input.type, input.contra, now, now);
  }

  async getAccount(id: string): Promise<Account | null> {
    const r = await this.db
      .prepare(`SELECT * FROM pluts_accounts WHERE id = ?`)
      .bind(id)
      .first<AccountRow>();
    return r ? toAccount(r) : null;
  }

  async getAccountByName(name: string): Promise<Account | null> {
    const r = await this.db
      .prepare(`SELECT * FROM pluts_accounts WHERE name = ?`)
      .bind(name)
      .first<AccountRow>();
    return r ? toAccount(r) : null;
  }

  async getAccountsByType(type: AccountType): Promise<Account[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM pluts_accounts WHERE type = ? ORDER BY name`)
      .bind(type)
      .all<AccountRow>();
    return results.map(toAccount);
  }

  async allAccounts(): Promise<Account[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM pluts_accounts ORDER BY name`)
      .all<AccountRow>();
    return results.map(toAccount);
  }

  async insertEntry(payload: EntryPayload): Promise<Entry> {
    const id = uuid();
    const now = new Date().toISOString();
    const doc = payload.commercialDocument;
    const { debits, credits } = amountsFromPayload(payload, id);

    const entryStmt = this.db
      .prepare(
        `INSERT INTO pluts_entries
          (id, description, date, commercial_document_id, commercial_document_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, payload.description, payload.date, doc?.id ?? null, doc?.type ?? null, now, now);

    const amountStmts = [...debits, ...credits].map((a) =>
      this.db
        .prepare(
          `INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(a.id, a.kind, a.account.id, id, Number(a.amount.signed())),
    );

    await this.db.batch([entryStmt, ...amountStmts]);

    return new Entry(id, payload.description, payload.date, doc, debits, credits, now, now);
  }

  async getEntry(id: string): Promise<Entry | null> {
    const row = await this.db
      .prepare(`SELECT * FROM pluts_entries WHERE id = ?`)
      .bind(id)
      .first<EntryRow>();
    if (!row) return null;
    return this.loadEntry(row);
  }

  async allEntries(order: 'asc' | 'desc' = 'desc'): Promise<Entry[]> {
    const dir = order === 'asc' ? 'ASC' : 'DESC';
    const { results } = await this.db
      .prepare(`SELECT * FROM pluts_entries ORDER BY date ${dir}`)
      .all<EntryRow>();
    return Promise.all(results.map((r) => this.loadEntry(r)));
  }

  async sumCredits(accountId: string, range?: DateRange): Promise<Amount> {
    return this.sumAmounts(accountId, 'credit', range);
  }

  async sumDebits(accountId: string, range?: DateRange): Promise<Amount> {
    return this.sumAmounts(accountId, 'debit', range);
  }

  async sumByType(type: AccountType, kind: 'credit' | 'debit', range?: DateRange): Promise<Amount> {
    const { clause, params } = dateRangeClause(range, 'e.');
    const sql = `SELECT COALESCE(SUM(a.amount), 0) AS total
      FROM pluts_amounts a
      JOIN pluts_accounts acc ON acc.id = a.account_id
      JOIN pluts_entries e ON e.id = a.entry_id
      WHERE acc.type = ? AND a.type = ? ${clause}`;
    const r = await this.db
      .prepare(sql)
      .bind(type, kind, ...params)
      .first<{ total: number }>();
    return Amount.fromSigned(BigInt(r?.total ?? 0));
  }

  async amountsForAccount(accountId: string): Promise<AmountRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT a.* FROM pluts_amounts a WHERE a.account_id = ? ORDER BY a.entry_id`)
      .bind(accountId)
      .all<AmountRow>();
    return this.hydrateAmounts(results);
  }

  async entriesForAccount(accountId: string): Promise<Entry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT e.* FROM pluts_entries e
         JOIN pluts_amounts a ON a.entry_id = e.id
         WHERE a.account_id = ? ORDER BY e.date DESC`,
      )
      .bind(accountId)
      .all<EntryRow>();
    return Promise.all(results.map((r) => this.loadEntry(r)));
  }

  private async sumAmounts(
    accountId: string,
    kind: AmountKind,
    range?: DateRange,
  ): Promise<Amount> {
    const { clause, params } = dateRangeClause(range, 'e.');
    const sql = `SELECT COALESCE(SUM(a.amount), 0) AS total
      FROM pluts_amounts a
      JOIN pluts_entries e ON e.id = a.entry_id
      WHERE a.account_id = ? AND a.type = ? ${clause}`;
    const r = await this.db
      .prepare(sql)
      .bind(accountId, kind, ...params)
      .first<{ total: number }>();
    return Amount.fromSigned(BigInt(r?.total ?? 0));
  }

  /** Builds a fully-formed immutable Entry from a row, loading its amounts. */
  private async loadEntry(row: EntryRow): Promise<Entry> {
    const { results } = await this.db
      .prepare(`SELECT * FROM pluts_amounts WHERE entry_id = ?`)
      .bind(row.id)
      .all<AmountRow>();
    const records = await this.hydrateAmounts(results);
    const debits = records.filter((r) => r.kind === 'debit');
    const credits = records.filter((r) => r.kind === 'credit');
    const doc =
      row.commercial_document_id && row.commercial_document_type
        ? ({
            id: row.commercial_document_id,
            type: row.commercial_document_type,
          } as CommercialDocumentRef)
        : null;
    return new Entry(
      row.id,
      row.description,
      row.date,
      doc,
      debits,
      credits,
      row.created_at,
      row.updated_at,
    );
  }

  private async hydrateAmounts(rows: AmountRow[]): Promise<AmountRecord[]> {
    if (rows.length === 0) return [];
    const accountIds = [...new Set(rows.map((r) => r.account_id))];
    const placeholders = accountIds.map(() => '?').join(',');
    const { results: accountRows } = await this.db
      .prepare(`SELECT * FROM pluts_accounts WHERE id IN (${placeholders})`)
      .bind(...accountIds)
      .all<AccountRow>();
    const accountMap = new Map(accountRows.map((r) => [r.id, toAccount(r)]));
    return rows.map((r) => {
      const account = accountMap.get(r.account_id);
      if (!account) throw new Error(`Missing account ${r.account_id} for amount ${r.id}`);
      return new AmountRecord(
        r.id,
        r.type as AmountKind,
        account,
        Amount.fromSigned(BigInt(r.amount)),
        r.entry_id,
      );
    });
  }
}
