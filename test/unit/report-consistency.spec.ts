import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";
import { SqlStorageRepository } from "../../src/db/sqlite-storage-repository";
import { computeBalance } from "../../src/domain/account";
import { Amount } from "../../src/domain/amount";
import { RepositoryError, ValidationError } from "../../src/domain/errors";
import { Ledger } from "../../src/domain/ledger";
import { AccountType } from "../../src/domain/types";
import { nodeSqlStorage } from "../helpers/node-sql-storage";

/**
 * Issue #28: reports were N+1 and, worse, not snapshot-consistent — the
 * `await`s between per-account sums let a write interleave mid-report. These
 * tests pin the single-query replacements to the per-account arithmetic they
 * replaced, and pin the pagination `allEntries` gained.
 */
describe("report queries (real SQLite)", () => {
  let repo: SqlStorageRepository;
  let ledger: Ledger;

  beforeEach(async () => {
    const db = new DatabaseSync(":memory:");
    const storage = nodeSqlStorage(db);
    migrate(storage.sql);
    repo = new SqlStorageRepository(storage);
    ledger = new Ledger(repo);

    await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
    await ledger.createAccount({
      name: "Depreciation",
      type: AccountType.Asset,
      contra: true,
    });
    await ledger.createAccount({ name: "Equity", type: AccountType.Equity });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });
    await ledger.createAccount({ name: "Expense", type: AccountType.Expense });
    // An account that never appears in an entry: it must still be listed.
    await ledger.createAccount({ name: "Unused", type: AccountType.Asset });

    await ledger.postEntry({
      description: "Invest",
      date: "2026-01-10",
      debits: [{ accountName: "Cash", amount: Amount.fromMajor(1000) }],
      credits: [{ accountName: "Equity", amount: Amount.fromMajor(1000) }],
    });
    await ledger.postEntry({
      description: "Sale",
      date: "2026-02-10",
      debits: [{ accountName: "Cash", amount: Amount.fromMajor(250) }],
      credits: [{ accountName: "Revenue", amount: Amount.fromMajor(250) }],
    });
    await ledger.postEntry({
      description: "Depreciate",
      date: "2026-03-10",
      debits: [{ accountName: "Expense", amount: Amount.fromMajor(40) }],
      credits: [{ accountName: "Depreciation", amount: Amount.fromMajor(40) }],
    });
  });

  it("accountTotals matches the per-account sums it replaced", async () => {
    const totals = await repo.accountTotals();
    expect(totals.map((t) => t.account.name)).toEqual([
      "Cash",
      "Depreciation",
      "Equity",
      "Expense",
      "Revenue",
      "Unused",
    ]);
    for (const { account, credits, debits } of totals) {
      expect(credits.minor).toBe((await repo.sumCredits(account.id)).minor);
      expect(debits.minor).toBe((await repo.sumDebits(account.id)).minor);
    }
  });

  it("accountTotals keeps zero-total accounts when a date range excludes their amounts", async () => {
    const totals = await repo.accountTotals({
      range: { fromDate: "2026-02-01", toDate: "2026-02-28" },
    });
    const byName = new Map(totals.map((t) => [t.account.name, t]));
    // Every account is still listed, including ones with nothing in range.
    expect(byName.size).toBe(6);
    expect(byName.get("Cash")?.debits.minor).toBe(25000n);
    expect(byName.get("Equity")?.credits.minor).toBe(0n);
    expect(byName.get("Unused")?.debits.minor).toBe(0n);
  });

  it("accountTotals filters by account type", async () => {
    const assets = await repo.accountTotals({ types: [AccountType.Asset] });
    expect(assets.map((t) => t.account.name)).toEqual([
      "Cash",
      "Depreciation",
      "Unused",
    ]);
    // Several types in one read: an income statement asks for exactly these.
    const income = await repo.accountTotals({
      types: [AccountType.Revenue, AccountType.Expense],
    });
    expect(income.map((t) => t.account.name)).toEqual(["Expense", "Revenue"]);
  });

  it("balanceByType equals the per-account computation", async () => {
    for (const type of Object.values(AccountType)) {
      const accounts = (await ledger.allAccounts()).filter(
        (a) => a.type === type,
      );
      let expected = 0n;
      for (const account of accounts) {
        const balance = computeBalance(
          account.type,
          account.contra,
          await repo.sumCredits(account.id),
          await repo.sumDebits(account.id),
        );
        expected += account.contra ? -balance : balance;
      }
      expect(await ledger.balanceByType(type)).toBe(expected);
    }
  });

  it("the trial balance listing equals the per-account computation", async () => {
    const report = await ledger.trialBalanceReport();
    let expectedDebits = 0n;
    let expectedCredits = 0n;
    for (const account of await ledger.allAccounts()) {
      const net =
        (await repo.sumDebits(account.id)).minor -
        (await repo.sumCredits(account.id)).minor;
      const row = report.rows.find((r) => r.account.id === account.id);
      expect(row).toBeDefined();
      expect(row?.debit).toBe(net >= 0n ? net : 0n);
      expect(row?.credit).toBe(net >= 0n ? 0n : -net);
      expectedDebits += net >= 0n ? net : 0n;
      expectedCredits += net >= 0n ? 0n : -net;
    }
    expect(report.totalDebits).toBe(expectedDebits);
    expect(report.totalCredits).toBe(expectedCredits);
    expect(report.balanced).toBe(true);
  });

  it("hydrates a batch of entries with the right lines each", async () => {
    const entries = await ledger.allEntries("asc");
    expect(entries.map((e) => e.description)).toEqual([
      "Invest",
      "Sale",
      "Depreciate",
    ]);
    for (const entry of entries) {
      expect(entry.debitAmounts).toHaveLength(1);
      expect(entry.creditAmounts).toHaveLength(1);
      expect(entry.debitAmounts[0]?.entryId).toBe(entry.id);
      expect(entry.creditAmounts[0]?.entryId).toBe(entry.id);
    }
    expect(entries[0]?.debitAmounts[0]?.account.name).toBe("Cash");
    expect(entries[2]?.creditAmounts[0]?.account.name).toBe("Depreciation");
  });

  it("rejects negative paging bounds instead of reading the whole journal", async () => {
    // SQLite reads a negative LIMIT as "unbounded" — the sentinel the
    // repository itself uses for an absent limit — so an unchecked bound from
    // a query string would return everything.
    await expect(
      ledger.allEntries("desc", { limit: -1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      ledger.allEntries("desc", { offset: -5 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      ledger.allEntries("desc", { limit: 1.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The repository guards the same seam directly, for callers bypassing the
    // Ledger facade.
    await expect(repo.allEntries("desc", { limit: -1 })).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });

  it("builds an income statement without reading unrelated account types", async () => {
    // Drive one asset account's *total* past SqlStorage's safe-integer range
    // while every individual amount stays inside it, and spread the credits
    // so no revenue account's total overflows.
    const huge = Amount.fromMajor(45_000_000_000_000);
    for (const name of ["Big A", "Big B", "Big C"]) {
      await ledger.createAccount({ name, type: AccountType.Revenue });
      await ledger.postEntry({
        description: `Whale sale to ${name}`,
        date: "2026-04-01",
        debits: [{ accountName: "Cash", amount: huge }],
        credits: [{ accountName: name, amount: huge }],
      });
    }

    // The asset total is now unreadable — a report that touches it fails
    // (with a RepositoryError from the safe-integer bridge, or a driver-level
    // RangeError before it, depending on the SQLite binding).
    await expect(ledger.balanceSheet()).rejects.toThrow();

    // The income statement reads only Revenue and Expense, so an unrelated
    // asset account cannot take it down.
    expect(await ledger.incomeStatement()).toEqual({
      revenue: 25000n + 3n * huge.minor,
      expenses: 4000n,
      netIncome: 25000n + 3n * huge.minor - 4000n,
    });
  });

  it("windows the journal with limit and offset", async () => {
    const all = await ledger.allEntries("asc");
    expect(await ledger.allEntries("asc", { limit: 2 })).toHaveLength(2);
    const page2 = await ledger.allEntries("asc", { limit: 2, offset: 2 });
    expect(page2.map((e) => e.description)).toEqual(["Depreciate"]);
    // An offset with no limit still skips.
    const skipped = await ledger.allEntries("asc", { offset: 1 });
    expect(skipped.map((e) => e.id)).toEqual(all.slice(1).map((e) => e.id));
    // Offset past the end is empty, not an error.
    expect(await ledger.allEntries("asc", { offset: 99 })).toEqual([]);
  });
});
