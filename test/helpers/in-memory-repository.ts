import type { Repository } from '../../src/db/repository.js';
import { Account } from '../../src/domain/account.js';
import { Amount } from '../../src/domain/amount.js';
import {
  AmountRecord,
  Entry,
  type EntryPayload,
  amountsFromPayload,
} from '../../src/domain/entry.js';
import { ValidationError } from '../../src/domain/errors.js';
import {
  type AccountType,
  type CommercialDocumentRef,
  type DateRange,
  toDateISO,
} from '../../src/domain/types.js';

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
  doc: CommercialDocumentRef | null;
  postedAt: string;
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
  private keyToEntry = new Map<string, string>();

  async insertAccount(input: {
    name: string;
    type: AccountType;
    contra: boolean;
  }): Promise<Account> {
    const key = `${input.name}\0${input.type}`;
    if (this.nameIndex.has(key)) {
      throw new ValidationError(
        [{ path: ['name'], message: 'has already been taken' }],
        'Account already exists',
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
    return [...this.accounts.values()].filter((a) => a.type === type).map(this.toAccount);
  }

  async allAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].map(this.toAccount);
  }

  async insertEntry(payload: EntryPayload): Promise<Entry> {
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

    const memEntry: MemEntry = {
      id,
      description: payload.description,
      date: payload.date,
      doc: payload.commercialDocument,
      postedAt: now,
      debitAmounts: debits,
      creditAmounts: credits,
    };
    this.entries.set(id, memEntry);
    if (payload.idempotencyKey) this.keyToEntry.set(payload.idempotencyKey, id);
    return this.toEntry(memEntry);
  }

  async getEntry(id: string): Promise<Entry | null> {
    const mem = this.entries.get(id);
    return mem ? this.toEntry(mem) : null;
  }

  async getEntryByKey(key: string): Promise<Entry | null> {
    const entryId = this.keyToEntry.get(key);
    if (!entryId) return null;
    const mem = this.entries.get(entryId);
    return mem ? this.toEntry(mem) : null;
  }

  async allEntries(order: 'asc' | 'desc' = 'desc'): Promise<Entry[]> {
    const list = [...this.entries.values()];
    list.sort((a, b) =>
      order === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date),
    );
    return list.map((m) => this.toEntry(m));
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

  async sumByType(type: AccountType, kind: 'credit' | 'debit', range?: DateRange): Promise<Amount> {
    let total = 0n;
    for (const rec of this.accounts.values()) {
      if (rec.type !== type) continue;
      const list = kind === 'credit' ? rec.credits : rec.debits;
      total += this.sum(list, range).minor;
    }
    return Amount.fromMinor(total);
  }

  async amountsForAccount(accountId: string): Promise<AmountRecord[]> {
    const rec = this.accounts.get(accountId);
    if (!rec) return [];
    const out: AmountRecord[] = [];
    for (const c of rec.credits) {
      const entry = this.entries.get(c.entryId);
      if (entry) out.push(...entry.creditAmounts.filter((a) => a.account.id === accountId));
    }
    for (const d of rec.debits) {
      const entry = this.entries.get(d.entryId);
      if (entry) out.push(...entry.debitAmounts.filter((a) => a.account.id === accountId));
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

  private sum(list: { amount: Amount; entryId: string }[], range?: DateRange): Amount {
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
    return new Entry(
      mem.id,
      mem.description,
      mem.date,
      mem.doc,
      mem.debitAmounts,
      mem.creditAmounts,
      mem.postedAt,
    );
  }
}
