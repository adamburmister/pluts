import type {
  AccountTotals,
  AccountTotalsOptions,
  EntryPageOptions,
  Repository,
} from "../../src/db/repository";
import { Account } from "../../src/domain/account";
import { Amount } from "../../src/domain/amount";
import {
  type AmountRecord,
  amountsFromPayload,
  assertBalanced,
  computeEntryFingerprint,
  Entry,
  type EntryPayload,
} from "../../src/domain/entry";
import {
  IdempotencyConflictError,
  ValidationError,
} from "../../src/domain/errors";
import {
  type AccountType,
  type DateRange,
  toDateISO,
} from "../../src/domain/types";

interface MemAccount {
  id: string;
  name: string;
  type: AccountType;
  contra: boolean;
  createdAt: string;
  credits: { amount: Amount; entryId: string }[];
  debits: { amount: Amount; entryId: string }[];
}
interface MemEntry {
  id: string;
  description: string;
  date: string;
  postedAt: string;
  seq: number;
  debitAmounts: AmountRecord[];
  creditAmounts: AmountRecord[];
}

function uuid(): string {
  return crypto.randomUUID();
}

function inRange(date: string, range?: DateRange): boolean {
  if (!range) return true;
  if (range.fromDate && date < toDateISO(range.fromDate)) return false;
  if (range.toDate && date > toDateISO(range.toDate)) return false;
  return true;
}

/** A pure in-memory Repository for fast unit tests with no storage dependency. */
export class InMemoryRepository implements Repository {
  private accounts = new Map<string, MemAccount>();
  private entries = new Map<string, MemEntry>();
  private nameIndex = new Map<string, string>();
  private seqCounter = 0;
  private keyToEntry = new Map<
    string,
    { entryId: string; payloadHash: string }
  >();

  async insertAccount(input: {
    name: string;
    type: AccountType;
    contra: boolean;
  }): Promise<Account> {
    const key = input.name;
    if (this.nameIndex.has(key)) {
      throw new ValidationError(
        [{ path: ["name"], message: "has already been taken" }],
        "Account already exists",
      );
    }
    const id = uuid();
    const now = new Date().toISOString();
    const rec: MemAccount = {
      id,
      name: input.name,
      type: input.type,
      contra: input.contra,
      createdAt: now,
      credits: [],
      debits: [],
    };
    this.accounts.set(id, rec);
    this.nameIndex.set(key, id);
    return new Account(id, input.name, input.type, input.contra, now);
  }

  private toAccount(rec: MemAccount): Account {
    return new Account(rec.id, rec.name, rec.type, rec.contra, rec.createdAt);
  }

  async getAccount(id: string): Promise<Account | null> {
    const rec = this.accounts.get(id);
    return rec ? this.toAccount(rec) : null;
  }

  async getAccountByName(name: string): Promise<Account | null> {
    const rec = [...this.accounts.values()].find((a) => a.name === name);
    return rec ? this.toAccount(rec) : null;
  }

  async getAccountsByType(type: AccountType): Promise<Account[]> {
    return [...this.accounts.values()]
      .filter((a) => a.type === type)
      .map(this.toAccount);
  }

  async allAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].map(this.toAccount);
  }

  async insertEntry(payload: EntryPayload): Promise<Entry> {
    assertBalanced(payload);
    // Mirror the SQL repository's unique-constraint semantics on the key
    // column: a duplicate key is either a genuine retry (same fingerprint —
    // return the original) or a collision (different fingerprint — throw).
    const payloadHash = payload.idempotencyKey
      ? await computeEntryFingerprint(payload)
      : "";
    if (payload.idempotencyKey) {
      const existing = this.keyToEntry.get(payload.idempotencyKey);
      if (existing) {
        if (existing.payloadHash && existing.payloadHash !== payloadHash) {
          throw new IdempotencyConflictError(
            payload.idempotencyKey,
            existing.entryId,
          );
        }
        const mem = this.entries.get(existing.entryId);
        if (mem) return this.toEntry(mem);
      }
    }

    const id = uuid();
    const now = new Date().toISOString();
    const { debits, credits } = amountsFromPayload(payload, id);

    for (const a of debits) {
      const rec = this.accounts.get(a.account.id);
      if (!rec) throw new Error(`Unknown account ${a.account.id}`);
      rec.debits.push({ amount: a.amount, entryId: id });
    }
    for (const a of credits) {
      const rec = this.accounts.get(a.account.id);
      if (!rec) throw new Error(`Unknown account ${a.account.id}`);
      rec.credits.push({ amount: a.amount, entryId: id });
    }

    this.seqCounter += 1;
    const memEntry: MemEntry = {
      id,
      description: payload.description,
      date: payload.date,
      postedAt: now,
      seq: this.seqCounter,
      debitAmounts: debits,
      creditAmounts: credits,
    };
    this.entries.set(id, memEntry);
    if (payload.idempotencyKey) {
      this.keyToEntry.set(payload.idempotencyKey, { entryId: id, payloadHash });
    }
    return this.toEntry(memEntry);
  }

  async getEntryKeyRecord(
    key: string,
  ): Promise<{ entryId: string; payloadHash: string } | null> {
    return this.keyToEntry.get(key) ?? null;
  }

  async getEntry(id: string): Promise<Entry | null> {
    const mem = this.entries.get(id);
    return mem ? this.toEntry(mem) : null;
  }

  async getEntryByKey(key: string): Promise<Entry | null> {
    const rec = this.keyToEntry.get(key);
    if (!rec) return null;
    const mem = this.entries.get(rec.entryId);
    return mem ? this.toEntry(mem) : null;
  }

  async allEntries(
    order: "asc" | "desc" = "desc",
    page: EntryPageOptions = {},
  ): Promise<Entry[]> {
    const list = [...this.entries.values()];
    // Deterministic journal order: date first, then posting sequence.
    list.sort((a, b) =>
      order === "asc"
        ? a.date.localeCompare(b.date) || a.seq - b.seq
        : b.date.localeCompare(a.date) || b.seq - a.seq,
    );
    // A cursor names a row, so continuation is stable across concurrent
    // posts and backdated entries; an offset only names a position.
    const after = page.after;
    const remaining = after
      ? list.filter((m) =>
          order === "asc"
            ? m.date > after.date ||
              (m.date === after.date && m.seq > after.seq)
            : m.date < after.date ||
              (m.date === after.date && m.seq < after.seq),
        )
      : list;
    const offset = page.offset ?? 0;
    const windowed =
      page.limit === undefined
        ? remaining.slice(offset)
        : remaining.slice(offset, offset + page.limit);
    return windowed.map((m) => this.toEntry(m));
  }

  async accountTotals(
    options: AccountTotalsOptions = {},
  ): Promise<AccountTotals[]> {
    return [...this.accounts.values()]
      .filter(
        (rec) =>
          options.types === undefined || options.types.includes(rec.type),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((rec) => ({
        account: this.toAccount(rec),
        credits: this.sum(rec.credits, options.range),
        debits: this.sum(rec.debits, options.range),
      }));
  }

  async entrySequenceStats(): Promise<{ count: number; maxSeq: number }> {
    let maxSeq = 0;
    for (const m of this.entries.values()) {
      if (m.seq > maxSeq) maxSeq = m.seq;
    }
    return { count: this.entries.size, maxSeq };
  }

  async sumCredits(accountId: string, range?: DateRange): Promise<Amount> {
    const rec = this.accounts.get(accountId);
    if (!rec) return Amount.zero();
    return this.sum(rec.credits, range);
  }

  async sumDebits(accountId: string, range?: DateRange): Promise<Amount> {
    const rec = this.accounts.get(accountId);
    if (!rec) return Amount.zero();
    return this.sum(rec.debits, range);
  }

  async sumByType(
    type: AccountType,
    kind: "credit" | "debit",
    range?: DateRange,
  ): Promise<Amount> {
    let total = 0n;
    for (const rec of this.accounts.values()) {
      if (rec.type !== type) continue;
      const list = kind === "credit" ? rec.credits : rec.debits;
      total += this.sum(list, range).minor;
    }
    return Amount.fromMinor(total);
  }

  async amountsForAccount(accountId: string): Promise<AmountRecord[]> {
    // Statement view: amounts in the owning entry's journal order
    // (date, seq), matching the SQL repository.
    const mems = [...this.entries.values()]
      .filter((m) =>
        [...m.debitAmounts, ...m.creditAmounts].some(
          (a) => a.account.id === accountId,
        ),
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
    const out: AmountRecord[] = [];
    for (const m of mems) {
      out.push(...m.debitAmounts.filter((a) => a.account.id === accountId));
      out.push(...m.creditAmounts.filter((a) => a.account.id === accountId));
    }
    return out;
  }

  async entriesForAccount(accountId: string): Promise<Entry[]> {
    const ids = new Set<string>();
    const rec = this.accounts.get(accountId);
    if (rec) {
      for (const c of rec.credits) ids.add(c.entryId);
      for (const d of rec.debits) ids.add(d.entryId);
    }
    return [...ids]
      .map((id) => this.entries.get(id))
      .filter((m): m is MemEntry => m !== undefined)
      .map((m) => this.toEntry(m));
  }

  private sum(
    list: { amount: Amount; entryId: string }[],
    range?: DateRange,
  ): Amount {
    let total = 0n;
    for (const item of list) {
      const entry = this.entries.get(item.entryId);
      if (!entry) continue;
      if (!inRange(entry.date, range)) continue;
      total += item.amount.minor;
    }
    return Amount.fromMinor(total);
  }

  private toEntry(mem: MemEntry): Entry {
    // Copy the line arrays: returned Entry objects must not alias internal
    // state (the SQL repository re-hydrates per query; the double must match).
    return new Entry(
      mem.id,
      mem.description,
      mem.date,
      [...mem.debitAmounts],
      [...mem.creditAmounts],
      mem.postedAt,
      mem.seq,
    );
  }
}
