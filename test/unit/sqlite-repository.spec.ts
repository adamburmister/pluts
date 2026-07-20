import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";
import { SqlStorageRepository } from "../../src/db/sqlite-storage-repository";
import { Account } from "../../src/domain/account";
import { Amount, formatAmount } from "../../src/domain/amount";
import { RepositoryError, ValidationError } from "../../src/domain/errors";
import { Ledger } from "../../src/domain/ledger";
import { AccountType } from "../../src/domain/types";
import { nodeSqlStorage } from "../helpers/node-sql-storage";

/**
 * F-11: the production SqlStorageRepository — where atomicity, rollback,
 * unique-constraint mapping, and SQL range semantics actually live — had no
 * tests in this repo; the suite ran only against the in-memory double. These
 * tests drive the real repository against a real SQLite engine (node:sqlite).
 */
describe("SqlStorageRepository (real SQLite)", () => {
  let db: DatabaseSync;
  let repo: SqlStorageRepository;
  let ledger: Ledger;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = nodeSqlStorage(db);
    migrate(storage.sql);
    repo = new SqlStorageRepository(storage);
    ledger = new Ledger(repo);
  });

  it("creates accounts and rejects duplicates via the unique index", async () => {
    const cash = await ledger.createAccount({
      name: "Cash",
      type: AccountType.Asset,
    });
    expect(cash.id).toBeTruthy();
    await expect(
      ledger.createAccount({ name: "Cash", type: AccountType.Asset }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("posts entries by account name and computes balances", async () => {
    const cash = await ledger.createAccount({
      name: "Cash",
      type: AccountType.Asset,
    });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });

    await ledger.postEntry({
      description: "Sale",
      date: "2026-01-10",
      debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
      credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
    });
    await ledger.postEntry({
      description: "Sale 2",
      date: "2026-06-10",
      debits: [{ accountName: "Cash", amount: Amount.fromMajor(50) }],
      credits: [{ accountName: "Revenue", amount: Amount.fromMajor(50) }],
    });

    expect(formatAmount(await ledger.accountBalance(cash))).toBe("150.00");
    // SQL date-range filtering (lexicographic on TEXT) matches the domain.
    const janOnly = await ledger.accountMovement(cash, {
      fromDate: "2026-01-01",
      toDate: "2026-01-31",
    });
    expect(formatAmount(janOnly)).toBe("100.00");
    // As-of balance is cumulative from inception.
    expect(formatAmount(await ledger.accountBalance(cash, "2026-01-31"))).toBe(
      "100.00",
    );
    expect(formatAmount(await ledger.balanceByType(AccountType.Revenue))).toBe(
      "150.00",
    );
  });

  it("keeps the trial balance at zero across types and contra accounts", async () => {
    const cash = await ledger.createAccount({
      name: "Cash",
      type: AccountType.Asset,
    });
    const stock = await ledger.createAccount({
      name: "Common Stock",
      type: AccountType.Equity,
    });
    const drawing = await ledger.createAccount({
      name: "Drawing",
      type: AccountType.Equity,
      contra: true,
    });

    await ledger.postEntry({
      description: "Invest",
      debits: [{ account: cash, amount: Amount.fromMajor(1000) }],
      credits: [{ account: stock, amount: Amount.fromMajor(1000) }],
    });
    await ledger.postEntry({
      description: "Withdraw",
      debits: [{ account: drawing, amount: Amount.fromMajor(400) }],
      credits: [{ account: cash, amount: Amount.fromMajor(400) }],
    });

    expect(await ledger.trialBalance()).toBe(0n);
    expect(formatAmount(await ledger.balanceByType(AccountType.Equity))).toBe(
      "600.00",
    );
    const bs = await ledger.balanceSheet();
    expect(bs.balanced).toBe(0n);
  });

  it("loads entries, per-account entries, and amounts", async () => {
    const cash = await ledger.createAccount({
      name: "Cash",
      type: AccountType.Asset,
    });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });
    const posted = await ledger.postEntry({
      description: "Sale",
      debits: [{ accountName: "Cash", amount: Amount.fromMajor(10) }],
      credits: [{ accountName: "Revenue", amount: Amount.fromMajor(10) }],
    });

    const loaded = await repo.getEntry(posted.id);
    expect(loaded?.description).toBe("Sale");
    expect(loaded?.debitAmounts).toHaveLength(1);
    expect(loaded?.debitAmounts[0]?.amount.toMajor()).toBe("10.00");
    expect(loaded?.debitAmounts[0]?.account.name).toBe("Cash");

    expect(await ledger.allEntries()).toHaveLength(1);
    expect(await ledger.entriesForAccount(cash)).toHaveLength(1);
    expect(await ledger.amountsForAccount(cash)).toHaveLength(1);
  });

  it("deduplicates idempotency-key retries", async () => {
    await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });
    const input = {
      idempotencyKey: "req-1",
      description: "Sale",
      debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
      credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
    };
    const first = await ledger.postEntry(input);
    const retry = await ledger.postEntry({ ...input });
    expect(retry.id).toBe(first.id);
    expect(await ledger.allEntries()).toHaveLength(1);
    expect((await repo.getEntryByKey("req-1"))?.id).toBe(first.id);
  });

  it("rolls back the whole entry when any row insert fails (atomicity)", async () => {
    const cash = await ledger.createAccount({
      name: "Cash",
      type: AccountType.Asset,
    });
    // A balanced payload whose credit references an account that does not
    // exist: the entry row and first amount insert succeed, the second
    // amount violates the FK — the transaction must leave nothing behind.
    const ghost = new Account(
      "no-such-account",
      "Ghost",
      AccountType.Revenue,
      false,
      "2026-01-01",
    );
    await expect(
      repo.insertEntry({
        description: "doomed",
        date: "2026-01-01",
        debits: [{ account: cash, amount: Amount.fromMajor(10) }],
        credits: [{ account: ghost, amount: Amount.fromMajor(10) }],
      }),
    ).rejects.toBeInstanceOf(RepositoryError);

    // No partial write: no entry row, no orphaned amount rows.
    expect(await ledger.allEntries()).toHaveLength(0);
    const amounts = db.prepare("SELECT COUNT(*) AS n FROM pluts_amounts").get();
    expect(amounts?.n).toBe(0);
    expect(formatAmount(await ledger.accountBalance(cash))).toBe("0.00");
  });
});

describe("InMemoryRepository does not alias internal state", () => {
  it("mutating a returned entry's arrays does not corrupt later reads", async () => {
    // The audit (probe P7) pushed onto a returned entry.debitAmounts —
    // readonly is compile-time only — and the tampered line appeared in
    // subsequent allEntries() reads: the double aliased its internal arrays.
    // Entry now freezes its arrays (F-16), so the push itself throws; either
    // way, later reads must come back clean.
    const { InMemoryRepository } = await import(
      "../helpers/in-memory-repository"
    );
    const ledger = new Ledger(new InMemoryRepository());
    await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });
    const entry = await ledger.postEntry({
      description: "sale",
      debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
      credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
    });

    expect(() =>
      (entry.debitAmounts as unknown as unknown[]).push("tampered"),
    ).toThrow(TypeError);

    const reread = await ledger.allEntries();
    expect(reread[0]?.debitAmounts).toHaveLength(1);
  });
});
