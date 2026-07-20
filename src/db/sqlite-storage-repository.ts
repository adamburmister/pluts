import type {
  DurableObjectStorage,
  SqlStorageValue,
} from "@cloudflare/workers-types";
import { Account } from "../domain/account.js";
import { Amount } from "../domain/amount.js";
import {
  type AmountKind,
  AmountRecord,
  amountsFromPayload,
  assertBalanced,
  computeEntryFingerprint,
  Entry,
  type EntryPayload,
} from "../domain/entry.js";
import {
  IdempotencyConflictError,
  RepositoryError,
  ValidationError,
} from "../domain/errors.js";
import {
  type AccountType,
  type DateRange,
  toDateISO,
} from "../domain/types.js";
import type {
  AccountTotals,
  AccountTotalsOptions,
  EntryPageOptions,
  Repository,
} from "./repository.js";

/**
 * Upper bound on placeholders in a generated `IN (...)` list. SQLite caps the
 * number of bound parameters per statement, so id lists are queried in chunks.
 * Chunking stays synchronous — no `await` between chunks — so the reads remain
 * one consistent view of the database.
 */
const MAX_IN_CLAUSE_IDS = 100;

/**
 * Guard a paging bound: `undefined` (absent) or a non-negative integer.
 * Anything else — a negative limit above all — would change the meaning of
 * the query rather than narrow it.
 */
function assertPageBound(
  value: number | undefined,
  name: "limit" | "offset",
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RepositoryError(
      `allEntries ${name} must be a non-negative integer, got ${value}`,
    );
  }
  return value;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Bridge a minor-units `bigint` onto SqlStorage's `number` bind type.
 *
 * SqlStorage cannot bind bigint, so every amount crosses an IEEE 754 boundary
 * at this seam. `Number()` does not error on precision loss — above 2^53 it
 * silently rounds, which for a ledger means corrupted money. Fail loudly
 * instead. (The ~2^53 ceiling is ~$90T at scale 2; it shrinks to ~90M major
 * units at scale 8, so the guard matters if SCALE is ever raised.)
 */
export function toStorageInt(minor: bigint): number {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RepositoryError(
      `Amount ${minor} minor units exceeds the exact integer range of SqlStorage (2^53 - 1)`,
    );
  }
  return Number(minor);
}

/**
 * Bridge a `number` read from SQLite (row value or SUM aggregate) back to
 * `bigint`. A non-integer or unsafe integer here means the stored data or an
 * aggregate crossed the exact range — silent corruption territory — or a
 * float reached the amount column through non-library SQL. Fail loudly.
 */
export function fromStorageInt(value: number, context: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new RepositoryError(
      `${context}: value ${value} is not an exact integer within SqlStorage's safe range`,
    );
  }
  return BigInt(value);
}

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
  seq: number;
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
    // The double-entry invariant is enforced here, at the persistence seam —
    // not only in the Ledger facade. EntryPayload is structurally
    // constructible, so a hand-built unbalanced payload must be rejected
    // before any row is written.
    assertBalanced(payload);
    const id = uuid();
    const now = new Date().toISOString();
    const { debits, credits } = amountsFromPayload(payload, id);
    const payloadHash = payload.idempotencyKey
      ? await computeEntryFingerprint(payload)
      : "";
    // Bridge amounts to storage numbers up front, so an out-of-range amount
    // fails before the transaction opens rather than mid-write.
    const lines = [...debits, ...credits].map((a) => ({
      record: a,
      storageAmount: toStorageInt(a.amount.minor),
    }));

    // The entry row, every amount row, and (if present) the idempotency-key row
    // must commit atomically. transactionSync runs its callback in one SQLite
    // transaction; if any statement throws, the whole thing rolls back.
    let seq = 0;
    try {
      this.storage.transactionSync(() => {
        // Next journal number, read inside the same transaction as the
        // insert. The DO is single-writer, so MAX+1 cannot race.
        const nextRow = this.sql
          .exec<{ [key: string]: SqlStorageValue; next: number }>(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM pluts_entries",
          )
          .one();
        seq = nextRow.next;
        this.sql
          .exec(
            "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES (?, ?, ?, ?, ?)",
            id,
            payload.description,
            payload.date,
            now,
            seq,
          )
          .toArray();

        for (const { record: a, storageAmount } of lines) {
          this.sql
            .exec(
              "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES (?, ?, ?, ?, ?)",
              a.id,
              a.kind,
              a.account.id,
              id,
              storageAmount,
            )
            .toArray();
        }

        if (payload.idempotencyKey) {
          this.sql
            .exec(
              "INSERT INTO pluts_entry_keys (key, entry_id, payload_hash) VALUES (?, ?, ?)",
              payload.idempotencyKey,
              id,
              payloadHash,
            )
            .toArray();
        }
      });
    } catch (e) {
      // Two concurrent posts sharing an idempotency key can race past the
      // pre-check in Ledger.postEntry; the loser's key insert hits the unique
      // constraint and the whole transaction rolls back. Recover by returning
      // the already-persisted entry — but only for a genuine retry. If the
      // stored fingerprint differs, the key was reused for different business
      // content: surface the collision instead of silently dropping it.
      if (payload.idempotencyKey && isUniqueConstraintError(e)) {
        const keyRecord = await this.getEntryKeyRecord(payload.idempotencyKey);
        if (keyRecord) {
          if (keyRecord.payloadHash !== payloadHash) {
            throw new IdempotencyConflictError(
              payload.idempotencyKey,
              keyRecord.entryId,
            );
          }
          const existing = await this.getEntry(keyRecord.entryId);
          if (existing) return existing;
        }
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
      seq,
    );
  }

  async entrySequenceStats(): Promise<{ count: number; maxSeq: number }> {
    const row = this.sql
      .exec<{ [key: string]: SqlStorageValue; count: number; maxSeq: number }>(
        "SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS maxSeq FROM pluts_entries",
      )
      .one();
    return { count: row.count, maxSeq: row.maxSeq };
  }

  async getEntry(id: string): Promise<Entry | null> {
    const rows = this.sql
      .exec<EntryRow>(
        "SELECT id, description, date, posted_at, seq FROM pluts_entries WHERE id = ?",
        id,
      )
      .toArray();
    const row = rows[0];
    return row ? this.loadEntry(row) : null;
  }

  async getEntryKeyRecord(
    key: string,
  ): Promise<{ entryId: string; payloadHash: string } | null> {
    const rows = this.sql
      .exec<{
        [key: string]: SqlStorageValue;
        entry_id: string;
        payload_hash: string;
      }>(
        "SELECT entry_id, payload_hash FROM pluts_entry_keys WHERE key = ?",
        key,
      )
      .toArray();
    const row = rows[0];
    return row
      ? { entryId: row.entry_id, payloadHash: row.payload_hash }
      : null;
  }

  async getEntryByKey(key: string): Promise<Entry | null> {
    const rows = this.sql
      .exec<EntryRow>(
        `SELECT e.id, e.description, e.date, e.posted_at, e.seq
         FROM pluts_entries e
         INNER JOIN pluts_entry_keys k ON k.entry_id = e.id
         WHERE k.key = ?`,
        key,
      )
      .toArray();
    const row = rows[0];
    return row ? this.loadEntry(row) : null;
  }

  async allEntries(
    order: "asc" | "desc" = "desc",
    page: EntryPageOptions = {},
  ): Promise<Entry[]> {
    const dir = order === "asc" ? "ASC" : "DESC";
    // SQLite requires a LIMIT before an OFFSET; -1 means "no limit". That
    // sentinel is why the bounds are checked here as well as at the facade:
    // a negative limit reaching SQLite reads as "unbounded", so an unchecked
    // `limit: -1` from a query string would return the whole journal.
    const limit = assertPageBound(page.limit, "limit") ?? -1;
    const offset = assertPageBound(page.offset, "offset") ?? 0;
    if (page.after && offset > 0) {
      throw new RepositoryError(
        "allEntries takes either a cursor (after) or an offset, not both",
      );
    }
    // Continue strictly past the cursor in the journal's (date, seq) order.
    // Written out rather than as a row-value comparison so the predicate
    // ports to any SQL backend implementing this Repository.
    const cursorClause = page.after
      ? order === "asc"
        ? " WHERE (date > ? OR (date = ? AND seq > ?))"
        : " WHERE (date < ? OR (date = ? AND seq < ?))"
      : "";
    const cursorBinds = page.after
      ? [page.after.date, page.after.date, page.after.seq]
      : [];
    const rows = this.sql
      .exec<EntryRow>(
        `SELECT id, description, date, posted_at, seq
         FROM pluts_entries${cursorClause}
         ORDER BY date ${dir}, seq ${dir}
         LIMIT ? OFFSET ?`,
        ...cursorBinds,
        limit,
        offset,
      )
      .toArray();
    return this.loadEntries(rows);
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
    return Amount.fromMinor(fromStorageInt(row.total ?? 0, "sumByType"));
  }

  async amountsForAccount(accountId: string): Promise<AmountRecord[]> {
    const rows = this.sql
      .exec<AmountRow>(
        `SELECT a.id, a.type, a.account_id, a.entry_id, a.amount
         FROM pluts_amounts a
         INNER JOIN pluts_entries e ON e.id = a.entry_id
         WHERE a.account_id = ?
         ORDER BY e.date ASC, e.seq ASC, a.id ASC`,
        accountId,
      )
      .toArray();
    return this.hydrateAmounts(rows);
  }

  async entriesForAccount(accountId: string): Promise<Entry[]> {
    const rows = this.sql
      .exec<EntryRow>(
        `SELECT DISTINCT e.id, e.description, e.date, e.posted_at, e.seq
         FROM pluts_entries e
         INNER JOIN pluts_amounts a ON a.entry_id = e.id
         WHERE a.account_id = ?
         ORDER BY e.date DESC, e.seq DESC`,
        accountId,
      )
      .toArray();
    return this.loadEntries(rows);
  }

  async accountTotals(
    options: AccountTotalsOptions = {},
  ): Promise<AccountTotals[]> {
    // An explicit empty list is a filter that matches nothing, not an absent
    // filter. Widening it to every account would quietly pull in the totals a
    // caller filtered out — omit `types` to ask for all of them.
    if (options.types?.length === 0) return [];
    const rangeClause = dateRangeClause(options.range);
    const types = options.types ?? [];
    const typeClause =
      types.length === 0
        ? ""
        : ` WHERE acc.type IN (${types.map(() => "?").join(", ")})`;
    // The date range filters the amounts *inside* the joined subquery, not the
    // outer result: an account whose amounts all fall outside the range must
    // still appear, with zero totals.
    const rows = this.sql
      .exec<{
        [key: string]: SqlStorageValue;
        id: string;
        name: string;
        type: string;
        contra: number;
        created_at: string;
        credits: number;
        debits: number;
      }>(
        `SELECT acc.id, acc.name, acc.type, acc.contra, acc.created_at,
                COALESCE(SUM(CASE WHEN a.type = 'credit' THEN a.amount END), 0) AS credits,
                COALESCE(SUM(CASE WHEN a.type = 'debit' THEN a.amount END), 0) AS debits
         FROM pluts_accounts acc
         LEFT JOIN (
           SELECT a.account_id, a.type, a.amount
           FROM pluts_amounts a
           INNER JOIN pluts_entries e ON e.id = a.entry_id
           WHERE 1 = 1${rangeClause.sql}
         ) a ON a.account_id = acc.id${typeClause}
         GROUP BY acc.id
         ORDER BY acc.name ASC`,
        ...rangeClause.binds,
        ...types,
      )
      .toArray();
    return rows.map((row) => ({
      account: toAccount(row),
      credits: Amount.fromMinor(
        fromStorageInt(row.credits, `credits for account ${row.id}`),
      ),
      debits: Amount.fromMinor(
        fromStorageInt(row.debits, `debits for account ${row.id}`),
      ),
    }));
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
    return Amount.fromMinor(fromStorageInt(row.total ?? 0, "sumAmounts"));
  }

  /** Builds a fully-formed immutable Entry from a row, loading its amounts. */
  private loadEntry(row: EntryRow): Entry {
    const entries = this.loadEntries([row]);
    const entry = entries[0];
    if (!entry) throw new RepositoryError(`Failed to load entry ${row.id}`);
    return entry;
  }

  /**
   * Builds Entries for a batch of entry rows, fetching every amount in one
   * query per chunk of ids instead of one query per entry (which made journal
   * reads O(entries) round-trips).
   */
  private loadEntries(rows: EntryRow[]): Entry[] {
    if (rows.length === 0) return [];
    const amountRows: AmountRow[] = [];
    for (const ids of chunk(
      rows.map((r) => r.id),
      MAX_IN_CLAUSE_IDS,
    )) {
      const placeholders = ids.map(() => "?").join(", ");
      amountRows.push(
        ...this.sql
          .exec<AmountRow>(
            `SELECT id, type, account_id, entry_id, amount
             FROM pluts_amounts
             WHERE entry_id IN (${placeholders})`,
            ...ids,
          )
          .toArray(),
      );
    }

    const byEntry = new Map<string, AmountRecord[]>();
    for (const record of this.hydrateAmounts(amountRows)) {
      const list = byEntry.get(record.entryId);
      if (list) list.push(record);
      else byEntry.set(record.entryId, [record]);
    }

    return rows.map((row) => {
      const records = byEntry.get(row.id) ?? [];
      return new Entry(
        row.id,
        row.description,
        row.date,
        records.filter((r) => r.kind === "debit"),
        records.filter((r) => r.kind === "credit"),
        row.posted_at,
        row.seq,
      );
    });
  }

  private hydrateAmounts(rows: AmountRow[]): AmountRecord[] {
    if (rows.length === 0) return [];
    const accountIds = [...new Set(rows.map((r) => r.account_id))];
    // SqlStorage.exec takes a fixed number of placeholders; build an IN (...)
    // query with one ? per id, chunked under SQLite's parameter cap. No await
    // between an exec and its .toArray() consumption, so the cursors are safe.
    const accountMap = new Map<string, Account>();
    for (const ids of chunk(accountIds, MAX_IN_CLAUSE_IDS)) {
      const placeholders = ids.map(() => "?").join(", ");
      const accountRows = this.sql
        .exec<AccountRow>(
          `SELECT id, name, type, contra, created_at FROM pluts_accounts WHERE id IN (${placeholders})`,
          ...ids,
        )
        .toArray();
      for (const r of accountRows) accountMap.set(r.id, toAccount(r));
    }
    return rows.map((r) => {
      const account = accountMap.get(r.account_id);
      if (!account)
        throw new Error(`Missing account ${r.account_id} for amount ${r.id}`);
      return new AmountRecord(
        r.id,
        r.type as AmountKind,
        account,
        Amount.fromMinor(fromStorageInt(r.amount, `amount ${r.id}`)),
        r.entry_id,
      );
    });
  }
}
