import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Account } from "../domain/account";
import { Amount } from "../domain/amount";
import {
  type AmountKind,
  AmountRecord,
  amountsFromPayload,
  Entry,
  type EntryPayload,
} from "../domain/entry";
import { RepositoryError, ValidationError } from "../domain/errors";
import { type AccountType, type DateRange, toDateISO } from "../domain/types";
import type { Repository } from "./repository";

/**
 * Raw row shapes (snake_case column names, as returned by SqlStorage cursors),
 * matching the columns defined in `./schema.ts`.
 */
interface AccountRow {
  [key: string]: SqlStorageValue;
  id: string;
  name: string;
  type: string;
  contra: number;
  created_at: string;
}
interface EntryRow {
  [key: string]: SqlStorageValue;
  id: string;
  description: string;
  date: string;
  posted_at: string;
}
interface AmountRow {
  [key: string]: SqlStorageValue;
  id: string;
  type: string;
  account_id: string;
  entry_id: string;
  amount: number;
}

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * SQLite surfaces unique-constraint violations as thrown errors whose `message`
 * contains "UNIQUE constraint failed" (case-insensitive). There is no typed
 * error class, so this string-matches the message.
 */
export function isUniqueConstraintError(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("message" in e)) return false;
  return /UNIQUE constraint failed/i.test(
    String((e as { message: unknown }).message),
  );
}

function toAccount(row: AccountRow): Account {
  return new Account(
    row.id,
    row.name,
    row.type as AccountType,
    !!row.contra,
    row.created_at,
  );
}

/**
 * Builds a date-range predicate fragment for the `pluts_entries` table. Returns
 * either the empty string (no range) or ` AND date >= ? AND date <= ?`; the
 * matching bound values are returned alongside for the exec bind list.
 */
function dateRangeClause(range: DateRange | undefined): {
  sql: string;
  binds: string[];
} {
  if (!range) return { sql: "", binds: [] };
  const clauses: string[] = [];
  const binds: string[] = [];
  if (range.fromDate) {
    clauses.push("date >= ?");
    binds.push(toDateISO(range.fromDate));
  }
  if (range.toDate) {
    clauses.push("date <= ?");
    binds.push(toDateISO(range.toDate));
  }
  if (clauses.length === 0) return { sql: "", binds: [] };
  return { sql: ` AND ${clauses.join(" AND ")}`, binds };
}

/**
 * Production {@link Repository} over a SQLite-backed Durable Object's own
 * storage (`ctx.storage.sql`), using the synchronous `SqlStorage` API.
 *
 * This is the storage backend when a Pluts ledger is hosted *inside* a Durable
 * Object: the DO's private SQLite database is the ledger. Each DO instance =
 * one isolated ledger.
 *
 * Notes on the `SqlStorage` API:
 * - `sql.exec(sql, ...binds)` is **synchronous** and returns a cursor that must
 *   be consumed (`.toArray()` / `.one()`) before the next `await` — there is no
 *   snapshot isolation across awaits. Every read here consumes its cursor
 *   immediately.
 * - Atomic entry posting uses `ctx.storage.transactionSync(callback)`: the
 *   entry row, all amount rows, and the idempotency-key row commit together or
 *   roll back together.
 *
 * Construct with the DO's `DurableObjectStorage` (which exposes both `.sql` and
 * `.transactionSync`):
 *
 * ```ts
 * new SqlStorageRepository(this.ctx.storage);
 * ```
 */
export class SqlStorageRepository implements Repository {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql() {
    return this.storage.sql;
  }

  async insertAccount(input: {
    name: string;
    type: AccountType;
    contra: boolean;
  }): Promise<Account> {
    const id = uuid();
    const now = new Date().toISOString();
    try {
      this.sql
        .exec(
          "INSERT INTO pluts_accounts (id, name, type, contra, created_at) VALUES (?, ?, ?, ?, ?)",
          id,
          input.name,
          input.type,
          input.contra ? 1 : 0,
          now,
        )
        .toArray();
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        throw new ValidationError(
          [{ path: ["name"], message: "has already been taken" }],
          "Account already exists",
        );
      }
      throw e;
    }
    return new Account(id, input.name, input.type, input.contra, now);
  }

  async getAccount(id: string): Promise<Account | null> {
    const rows = this.sql
      .exec<AccountRow>(
        "SELECT id, name, type, contra, created_at FROM pluts_accounts WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    return row ? toAccount(row) : null;
  }

  async getAccountByName(name: string): Promise<Account | null> {
    const rows = this.sql
      .exec<AccountRow>(
        "SELECT id, name, type, contra, created_at FROM pluts_accounts WHERE name = ?",
        name,
      )
      .toArray();
    const row = rows[0];
    return row ? toAccount(row) : null;
  }

  async getAccountsByType(type: AccountType): Promise<Account[]> {
    return this.sql
      .exec<AccountRow>(
        "SELECT id, name, type, contra, created_at FROM pluts_accounts WHERE type = ? ORDER BY name ASC",
        type,
      )
      .toArray()
      .map(toAccount);
  }

  async allAccounts(): Promise<Account[]> {
    return this.sql
      .exec<AccountRow>(
        "SELECT id, name, type, contra, created_at FROM pluts_accounts ORDER BY name ASC",
      )
      .toArray()
      .map(toAccount);
  }

  async insertEntry(payload: EntryPayload): Promise<Entry> {
    const id = uuid();
    const now = new Date().toISOString();
    const { debits, credits } = amountsFromPayload(payload, id);

    // The entry row, every amount row, and (if present) the idempotency-key row
    // must commit atomically. transactionSync runs its callback in one SQLite
    // transaction; if any statement throws, the whole thing rolls back.
    try {
      this.storage.transactionSync(() => {
        this.sql
          .exec(
            "INSERT INTO pluts_entries (id, description, date, posted_at) VALUES (?, ?, ?, ?)",
            id,
            payload.description,
            payload.date,
            now,
          )
          .toArray();

        for (const a of [...debits, ...credits]) {
          this.sql
            .exec(
              "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES (?, ?, ?, ?, ?)",
              a.id,
              a.kind,
              a.account.id,
              id,
              Number(a.amount.minor),
            )
            .toArray();
        }

        if (payload.idempotencyKey) {
          this.sql
            .exec(
              "INSERT INTO pluts_entry_keys (key, entry_id) VALUES (?, ?)",
              payload.idempotencyKey,
              id,
            )
            .toArray();
        }
      });
    } catch (e) {
      // Two concurrent posts sharing an idempotency key can race past the
      // pre-check in Ledger.postEntry; the loser's key insert hits the unique
      // constraint and the whole transaction rolls back. Recover by returning
      // the already-persisted entry.
      if (payload.idempotencyKey && isUniqueConstraintError(e)) {
        const existing = await this.getEntryByKey(payload.idempotencyKey);
        if (existing) return existing;
      }
      throw new RepositoryError("Failed to persist entry", e);
    }

    return new Entry(
      id,
      payload.description,
      payload.date,
      debits,
      credits,
      now,
    );
  }

  async getEntry(id: string): Promise<Entry | null> {
    const rows = this.sql
      .exec<EntryRow>(
        "SELECT id, description, date, posted_at FROM pluts_entries WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    return row ? this.loadEntry(row) : null;
  }

  async getEntryByKey(key: string): Promise<Entry | null> {
    const rows = this.sql
      .exec<EntryRow>(
        `SELECT e.id, e.description, e.date, e.posted_at
         FROM pluts_entries e
         INNER JOIN pluts_entry_keys k ON k.entry_id = e.id
         WHERE k.key = ?`,
        key,
      )
      .toArray();
    const row = rows[0];
    return row ? this.loadEntry(row) : null;
  }

  async allEntries(order: "asc" | "desc" = "desc"): Promise<Entry[]> {
    const dir = order === "asc" ? "ASC" : "DESC";
    const rows = this.sql
      .exec<EntryRow>(
        `SELECT id, description, date, posted_at FROM pluts_entries ORDER BY date ${dir}`,
      )
      .toArray();
    // loadEntry issues its own exec per entry. SqlStorage cursors are consumed
    // synchronously inside loadEntry, so iterating here is safe.
    return rows.map((r) => this.loadEntry(r));
  }

  async sumCredits(accountId: string, range?: DateRange): Promise<Amount> {
    return this.sumAmounts(accountId, "credit", range);
  }

  async sumDebits(accountId: string, range?: DateRange): Promise<Amount> {
    return this.sumAmounts(accountId, "debit", range);
  }

  async sumByType(
    type: AccountType,
    kind: AmountKind,
    range?: DateRange,
  ): Promise<Amount> {
    const rangeClause = dateRangeClause(range);
    // An aggregate SELECT always returns exactly one row, so .one() is safe.
    const row = this.sql
      .exec<{ total: number | null }>(
        `SELECT COALESCE(SUM(a.amount), 0) AS total
         FROM pluts_amounts a
         INNER JOIN pluts_accounts acc ON acc.id = a.account_id
         INNER JOIN pluts_entries e ON e.id = a.entry_id
         WHERE acc.type = ? AND a.type = ?${rangeClause.sql}`,
        type,
        kind,
        ...rangeClause.binds,
      )
      .one();
    return Amount.fromMinor(BigInt(row.total ?? 0));
  }

  async amountsForAccount(accountId: string): Promise<AmountRecord[]> {
    const rows = this.sql
      .exec<AmountRow>(
        "SELECT id, type, account_id, entry_id, amount FROM pluts_amounts WHERE account_id = ? ORDER BY entry_id ASC",
        accountId,
      )
      .toArray();
    return this.hydrateAmounts(rows);
  }

  async entriesForAccount(accountId: string): Promise<Entry[]> {
    const rows = this.sql
      .exec<EntryRow>(
        `SELECT DISTINCT e.id, e.description, e.date, e.posted_at
         FROM pluts_entries e
         INNER JOIN pluts_amounts a ON a.entry_id = e.id
         WHERE a.account_id = ?
         ORDER BY e.date DESC`,
        accountId,
      )
      .toArray();
    return rows.map((r) => this.loadEntry(r));
  }

  private async sumAmounts(
    accountId: string,
    kind: AmountKind,
    range?: DateRange,
  ): Promise<Amount> {
    const rangeClause = dateRangeClause(range);
    const row = this.sql
      .exec<{ total: number | null }>(
        `SELECT COALESCE(SUM(a.amount), 0) AS total
         FROM pluts_amounts a
         INNER JOIN pluts_entries e ON e.id = a.entry_id
         WHERE a.account_id = ? AND a.type = ?${rangeClause.sql}`,
        accountId,
        kind,
        ...rangeClause.binds,
      )
      .one();
    return Amount.fromMinor(BigInt(row.total ?? 0));
  }

  /** Builds a fully-formed immutable Entry from a row, loading its amounts. */
  private loadEntry(row: EntryRow): Entry {
    const amounts = this.sql
      .exec<AmountRow>(
        "SELECT id, type, account_id, entry_id, amount FROM pluts_amounts WHERE entry_id = ?",
        row.id,
      )
      .toArray();
    const records = this.hydrateAmounts(amounts);
    const debits = records.filter((r) => r.kind === "debit");
    const credits = records.filter((r) => r.kind === "credit");
    return new Entry(
      row.id,
      row.description,
      row.date,
      debits,
      credits,
      row.posted_at,
    );
  }

  private hydrateAmounts(rows: AmountRow[]): AmountRecord[] {
    if (rows.length === 0) return [];
    const accountIds = [...new Set(rows.map((r) => r.account_id))];
    // SqlStorage.exec takes a fixed number of placeholders; build a single
    // IN (...) query with one ? per id. No await between the exec and the
    // .toArray() consumption, so the cursor is safe.
    const placeholders = accountIds.map(() => "?").join(", ");
    const accountRows = this.sql
      .exec<AccountRow>(
        `SELECT id, name, type, contra, created_at FROM pluts_accounts WHERE id IN (${placeholders})`,
        ...accountIds,
      )
      .toArray();
    const accountMap = new Map(accountRows.map((r) => [r.id, toAccount(r)]));
    return rows.map((r) => {
      const account = accountMap.get(r.account_id);
      if (!account)
        throw new Error(`Missing account ${r.account_id} for amount ${r.id}`);
      return new AmountRecord(
        r.id,
        r.type as AmountKind,
        account,
        Amount.fromMinor(BigInt(r.amount)),
        r.entry_id,
      );
    });
  }
}
