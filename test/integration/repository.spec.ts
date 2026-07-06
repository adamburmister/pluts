import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1Repository } from '../../src/db/d1-repository.js';
import { Account } from '../../src/domain/account.js';
import { Amount } from '../../src/domain/amount.js';
import { type EntryPayload } from '../../src/domain/entry.js';
import { ValidationError } from '../../src/domain/errors.js';
import { AccountType } from '../../src/domain/types.js';
import { createTestD1, truncateAll } from '../helpers/miniflare.js';

function buildPayload(
  description: string,
  debit: Account,
  credit: Account,
  amount: Amount,
  date: string,
): EntryPayload {
  return {
    description,
    date,
    commercialDocument: null,
    debits: [{ account: debit, amount }],
    credits: [{ account: credit, amount }],
  };
}

describe('D1Repository', () => {
  let d1: D1Database;
  let repo: D1Repository;

  beforeEach(async () => {
    d1 = await createTestD1();
    repo = new D1Repository(d1);
  });

  afterEach(async () => {
    await truncateAll(d1);
  });

  describe('accounts', () => {
    it('inserts and retrieves an account', async () => {
      const acc = await repo.insertAccount({
        name: 'Cash',
        type: AccountType.Asset,
        contra: false,
      });
      expect(acc.id).toBeTruthy();
      const fetched = await repo.getAccount(acc.id);
      expect(fetched?.name).toBe('Cash');
      expect(fetched?.type).toBe(AccountType.Asset);
      expect(fetched?.contra).toBe(false);
    });

    it('looks up an account by name', async () => {
      await repo.insertAccount({ name: 'Cash', type: AccountType.Asset, contra: false });
      const fetched = await repo.getAccountByName('Cash');
      expect(fetched?.name).toBe('Cash');
    });

    it('returns accounts of a given type', async () => {
      await repo.insertAccount({ name: 'Cash', type: AccountType.Asset, contra: false });
      await repo.insertAccount({ name: 'Bank', type: AccountType.Asset, contra: false });
      await repo.insertAccount({ name: 'Rev', type: AccountType.Revenue, contra: false });
      const assets = await repo.getAccountsByType(AccountType.Asset);
      expect(assets).toHaveLength(2);
    });

    it('maps a duplicate insert to a ValidationError (not a raw D1 error)', async () => {
      await repo.insertAccount({ name: 'Cash', type: AccountType.Asset, contra: false });
      // Both calls pass any application-level check (the TOCTOU window); the DB
      // unique index is the source of truth and insertAccount must surface the
      // violation as a ValidationError.
      await expect(
        repo.insertAccount({ name: 'Cash', type: AccountType.Asset, contra: false }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a CHECK-violating account type at the DB level', async () => {
      await expect(
        repo.insertAccount({ name: 'Bad', type: 'Foo' as AccountType, contra: false }),
      ).rejects.toThrow();
    });
  });

  describe('entries and amounts', () => {
    it('inserts an entry with amounts atomically', async () => {
      const cash = await repo.insertAccount({
        name: 'Cash',
        type: AccountType.Asset,
        contra: false,
      });
      const rev = await repo.insertAccount({
        name: 'Rev',
        type: AccountType.Revenue,
        contra: false,
      });

      const payload = buildPayload('Sale', cash, rev, Amount.fromMajor(100), '2024-01-01');

      const saved = await repo.insertEntry(payload);
      expect(saved.id).toBeTruthy();

      const fetched = await repo.getEntry(saved.id);
      expect(fetched?.description).toBe('Sale');
      expect(fetched?.debitAmounts).toHaveLength(1);
      expect(fetched?.creditAmounts).toHaveLength(1);
      expect(fetched?.debitAmounts[0]?.account.id).toBe(cash.id);
      expect(fetched?.debitAmounts[0]?.amount.toMajor()).toBe('100.00');
    });

    it('sums credit and debit totals per account', async () => {
      const cash = await repo.insertAccount({
        name: 'Cash',
        type: AccountType.Asset,
        contra: false,
      });
      const rev = await repo.insertAccount({
        name: 'Rev',
        type: AccountType.Revenue,
        contra: false,
      });

      await postSimple(repo, cash, rev, 100, '2024-01-01');
      await postSimple(repo, cash, rev, 50, '2024-02-01');

      const credits = await repo.sumCredits(rev.id);
      const debits = await repo.sumDebits(cash.id);
      expect(credits.toMajor()).toBe('150.00');
      expect(debits.toMajor()).toBe('150.00');
    });

    it('sums within a date range', async () => {
      const cash = await repo.insertAccount({
        name: 'Cash',
        type: AccountType.Asset,
        contra: false,
      });
      const rev = await repo.insertAccount({
        name: 'Rev',
        type: AccountType.Revenue,
        contra: false,
      });

      await postSimple(repo, cash, rev, 100, '2024-01-10');
      await postSimple(repo, cash, rev, 50, '2024-06-10');

      const ranged = await repo.sumDebits(cash.id, {
        fromDate: '2024-01-01',
        toDate: '2024-02-01',
      });
      expect(ranged.toMajor()).toBe('100.00');
    });

    it('sums amounts by account type', async () => {
      const cash = await repo.insertAccount({
        name: 'Cash',
        type: AccountType.Asset,
        contra: false,
      });
      const bank = await repo.insertAccount({
        name: 'Bank',
        type: AccountType.Asset,
        contra: false,
      });
      const rev = await repo.insertAccount({
        name: 'Rev',
        type: AccountType.Revenue,
        contra: false,
      });

      await postSimple(repo, cash, rev, 100, '2024-01-01');
      await postSimple(repo, bank, rev, 50, '2024-01-02');

      const assetDebits = await repo.sumByType(AccountType.Asset, 'debit');
      expect(assetDebits.toMajor()).toBe('150.00');
    });

    it('returns amounts and entries for an account', async () => {
      const cash = await repo.insertAccount({
        name: 'Cash',
        type: AccountType.Asset,
        contra: false,
      });
      const rev = await repo.insertAccount({
        name: 'Rev',
        type: AccountType.Revenue,
        contra: false,
      });
      await postSimple(repo, cash, rev, 100, '2024-01-01');
      await postSimple(repo, cash, rev, 50, '2024-01-02');

      const amounts = await repo.amountsForAccount(cash.id);
      expect(amounts).toHaveLength(2);
      const entries = await repo.entriesForAccount(cash.id);
      expect(entries).toHaveLength(2);
    });
  });
});

async function postSimple(
  repo: D1Repository,
  debit: Account,
  credit: Account,
  major: number,
  date: string,
): Promise<void> {
  await repo.insertEntry(buildPayload('entry', debit, credit, Amount.fromMajor(major), date));
}
