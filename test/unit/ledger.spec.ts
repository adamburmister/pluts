import { beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../../src/domain/account";
import { Amount, formatAmount } from "../../src/domain/amount";
import type { AccountDTO } from "../../src/domain/dto";
import { ValidationError } from "../../src/domain/errors";
import { Ledger } from "../../src/domain/ledger";
import { AccountType } from "../../src/domain/types";
import { InMemoryRepository } from "../helpers/in-memory-repository";

describe("Ledger (in-memory)", () => {
  let ledger: Ledger;

  beforeEach(() => {
    ledger = new Ledger(new InMemoryRepository());
  });

  describe("createAccount", () => {
    it("creates an account", async () => {
      const acc = await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      expect(acc.name).toBe("Cash");
      expect(acc.type).toBe(AccountType.Asset);
      expect(acc.contra).toBe(false);
    });

    it("rejects duplicate names", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await expect(
        ledger.createAccount({ name: "Cash", type: AccountType.Asset }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // F-01: names must be unique across ALL types. Two accounts named "Cash"
    // with different types would make name-based posting ambiguous — the
    // debit would land on whichever row the lookup returned first.
    it("rejects duplicate names across different account types", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await expect(
        ledger.createAccount({ name: "Cash", type: AccountType.Liability }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("creates contra accounts", async () => {
      const acc = await ledger.createAccount({
        name: "Drawing",
        type: AccountType.Equity,
        contra: true,
      });
      expect(acc.contra).toBe(true);
    });
  });

  describe("postEntry", () => {
    it("posts a balanced entry and updates balances", async () => {
      const cash = await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });

      const entry = await ledger.postEntry({
        description: "Sale",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      });

      expect(entry.id).toBeTruthy();
      expect(entry.description).toBe("Sale");

      const bal = await ledger.accountBalance(cash);
      expect(formatAmount(bal)).toBe("100.00");
    });

    it("accepts account objects directly", async () => {
      const cash = await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      const rev = await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });

      const entry = await ledger.postEntry({
        description: "Sale",
        debits: [{ account: cash, amount: Amount.fromMajor(50) }],
        credits: [{ account: rev, amount: Amount.fromMajor(50) }],
      });
      // biome-ignore lint/style/noNonNullAssertion: Testing
      expect(entry.debitAmounts[0]!.account.id).toBe(cash.id);
    });

    it("throws ValidationError when amounts do not cancel", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      await expect(
        ledger.postEntry({
          description: "Bad",
          debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
          credits: [{ accountName: "Revenue", amount: Amount.fromMajor(99) }],
        }),
      ).rejects.toMatchObject({ name: "ValidationError" });
    });

    it("throws ValidationError when description is blank", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      await expect(
        ledger.postEntry({
          description: "",
          debits: [{ accountName: "Cash", amount: Amount.fromMajor(1) }],
          credits: [{ accountName: "Revenue", amount: Amount.fromMajor(1) }],
        }),
      ).rejects.toMatchObject({ name: "ValidationError" });
    });

    // Untyped JS can post a structurally malformed body; the name-prefetch
    // scan must not blow up with a raw TypeError before validation runs.
    it("throws ValidationError (not TypeError) when a lines array is missing", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await expect(
        ledger.postEntry({
          idempotencyKey: "req-malformed",
          description: "Bad shape",
          debits: [{ accountName: "Cash", amount: Amount.fromMajor(1) }],
        } as unknown as Parameters<typeof ledger.postEntry>[0]),
      ).rejects.toMatchObject({ name: "ValidationError" });
    });

    it("defaults the date to today", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      const entry = await ledger.postEntry({
        description: "Sale",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(1) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(1) }],
      });
      expect(entry.date).toBe(new Date().toISOString().slice(0, 10));
    });
  });

  describe("accountsWithBalances", () => {
    it("returns every account with its net balance in major units", async () => {
      const cash = await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      const revenue = await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      await ledger.postEntry({
        description: "Sale",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      });

      const dtos = await ledger.accountsWithBalances();
      expect(dtos).toHaveLength(2);
      const byName = (name: string): AccountDTO => {
        const found = dtos.find((d) => d.name === name);
        expect(found).toBeDefined();
        return found as AccountDTO;
      };
      expect(byName("Cash").balance).toBe("100.00");
      expect(byName("Revenue").balance).toBe("100.00");
      expect(byName("Cash").id).toBe(cash.id);
      expect(byName("Revenue").id).toBe(revenue.id);
    });

    it("reports a zero balance for an account with no activity", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      const [cash] = await ledger.accountsWithBalances();
      expect(cash?.balance).toBe("0.00");
    });

    it("returns DTOs without breaking the RPC/JSON boundary", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      const dtos = await ledger.accountsWithBalances();
      const cloned = structuredClone(dtos);
      expect(() => JSON.stringify(cloned)).not.toThrow();
      expect(cloned[0]?.balance).toBe("0.00");
    });

    it("honors a type filter", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      const dtos = await ledger.accountsWithBalances({
        types: [AccountType.Asset],
      });
      expect(dtos.map((d) => d.name)).toEqual(["Cash"]);
    });

    it("formats a negative balance for a contra account", async () => {
      await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      await ledger.createAccount({
        name: "Drawing",
        type: AccountType.Equity,
        contra: true,
      });
      await ledger.postEntry({
        description: "Owner withdrawal",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(50) }],
        credits: [{ accountName: "Drawing", amount: Amount.fromMajor(50) }],
      });

      const dtos = await ledger.accountsWithBalances();
      const byName = (name: string): AccountDTO => {
        const found = dtos.find((d) => d.name === name);
        expect(found).toBeDefined();
        return found as AccountDTO;
      };
      // Drawing is a contra-equity (normal credit balance) account, so a credit
      // makes its net balance negative.
      expect(byName("Drawing").balance).toBe("-50.00");
      expect(byName("Cash").balance).toBe("50.00");
    });
  });

  describe("idempotency", () => {
    it("returns the previously-persisted entry for an identical retry", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });

      const input = {
        idempotencyKey: "req-123",
        description: "Sale",
        date: "2026-01-05",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      };

      const first = await ledger.postEntry(input);
      // A byte-identical retry (network replay, DO re-execution) must return
      // the same entry, never post a duplicate.
      const retry = await ledger.postEntry({ ...input });
      expect(retry.id).toBe(first.id);
      expect(retry.description).toBe("Sale");
      expect(await ledger.allEntries()).toHaveLength(1);
    });

    // F-05: the same key with a *different* payload is a client bug, not a
    // retry. Silently returning the original entry means the second
    // transaction is never recorded — a lost posting. It must fail loudly.
    it("throws IdempotencyConflictError when the key is reused with a different payload", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });

      const first = await ledger.postEntry({
        idempotencyKey: "req-123",
        description: "Sale A",
        date: "2026-01-05",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      });

      await expect(
        ledger.postEntry({
          idempotencyKey: "req-123",
          description: "Sale B (different!)",
          date: "2026-01-05",
          debits: [{ accountName: "Cash", amount: Amount.fromMajor(999) }],
          credits: [{ accountName: "Revenue", amount: Amount.fromMajor(999) }],
        }),
      ).rejects.toMatchObject({
        name: "IdempotencyConflictError",
        key: "req-123",
        existingEntryId: first.id,
      });
      // The conflicting post must not have written anything.
      expect(await ledger.allEntries()).toHaveLength(1);
    });

    it("validates the payload even when the key was already used", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      await ledger.postEntry({
        idempotencyKey: "req-123",
        description: "Sale",
        date: "2026-01-05",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      });
      // An unbalanced "retry" is invalid input, not a dedup hit.
      await expect(
        ledger.postEntry({
          idempotencyKey: "req-123",
          description: "Sale",
          date: "2026-01-05",
          debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
          credits: [{ accountName: "Revenue", amount: Amount.fromMajor(99) }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("posts independently when no key is supplied", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      const base = {
        description: "Sale",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      };
      await ledger.postEntry(base);
      await ledger.postEntry(base);
      expect(await ledger.allEntries()).toHaveLength(2);
    });
  });

  describe("balances by type and date ranges", () => {
    it("aggregates balances across accounts of a type", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({ name: "Bank", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });

      await ledger.postEntry({
        description: "Sale 1",
        date: "2024-01-10",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      });
      await ledger.postEntry({
        description: "Sale 2",
        date: "2024-06-10",
        debits: [{ accountName: "Bank", amount: Amount.fromMajor(50) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(50) }],
      });

      expect(formatAmount(await ledger.balanceByType(AccountType.Asset))).toBe(
        "150.00",
      );
      expect(
        formatAmount(await ledger.balanceByType(AccountType.Revenue)),
      ).toBe("150.00");

      // Point-in-time: as-of cuts off later entries.
      const asOfJan = await ledger.balanceByType(
        AccountType.Asset,
        "2024-02-01",
      );
      expect(formatAmount(asOfJan)).toBe("100.00");

      // Period movement: a range excludes activity outside it.
      const janMovement = await ledger.movementByType(AccountType.Asset, {
        fromDate: "2024-01-01",
        toDate: "2024-02-01",
      });
      expect(formatAmount(janMovement)).toBe("100.00");
    });

    // #26: a fromDate on a "balance" turned it into a period movement
    // mislabelled as a balance. accountBalance is now as-of-only (cumulative
    // from inception); accountMovement handles ranges explicitly.
    it("distinguishes balance (as-of, cumulative) from movement (period net)", async () => {
      const cash = await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });

      // Prior-period activity...
      await ledger.postEntry({
        description: "Opening sale",
        date: "2026-05-15",
        debits: [{ account: cash, amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      });
      // ...and current-period activity.
      await ledger.postEntry({
        description: "June sale",
        date: "2026-06-10",
        debits: [{ account: cash, amount: Amount.fromMajor(40) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(40) }],
      });

      // Balance as of end of June includes the prior period.
      expect(
        formatAmount(await ledger.accountBalance(cash, "2026-06-30")),
      ).toBe("140.00");
      // June movement excludes it.
      const june = { fromDate: "2026-06-01", toDate: "2026-06-30" };
      expect(formatAmount(await ledger.accountMovement(cash, june))).toBe(
        "40.00",
      );
      expect(
        formatAmount(await ledger.movementByType(AccountType.Asset, june)),
      ).toBe("40.00");
      // An unbounded movement equals the all-time balance.
      expect(formatAmount(await ledger.accountMovement(cash, {}))).toBe(
        "140.00",
      );
    });

    // F-02: range parameters were passed to the repository unvalidated; a
    // malformed bound silently mis-filters every period report.
    it("rejects malformed date-range bounds with ValidationError", async () => {
      const cash = await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      await expect(
        ledger.accountBalance(cash, "2024-1-5"),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        ledger.balanceByType(AccountType.Asset, "garbage"),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        ledger.accountMovement(cash, { fromDate: "2024-1-5" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        ledger.movementByType(AccountType.Asset, { toDate: "garbage" }),
      ).rejects.toBeInstanceOf(ValidationError);
      // trialBalance/balanceSheet take an as-of date (F-09); malformed
      // as-of values must still fail validation (F-02).
      await expect(ledger.trialBalance("2024-02-30")).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(ledger.balanceSheet("not-a-date")).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        ledger.trialBalanceReport("2024-1-5"),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        ledger.incomeStatement({ fromDate: "2024/01/01" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("subtracts contra accounts in balanceByType", async () => {
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

      // Owner invests 1000: Cash (dr) 1000, Common Stock (cr) 1000
      await ledger.postEntry({
        description: "Invest",
        debits: [{ account: cash, amount: Amount.fromMajor(1000) }],
        credits: [{ account: stock, amount: Amount.fromMajor(1000) }],
      });
      // Owner withdraws 400: Drawing (contra equity, dr) 400, Cash (cr) 400
      await ledger.postEntry({
        description: "Withdraw",
        debits: [{ account: drawing, amount: Amount.fromMajor(400) }],
        credits: [{ account: cash, amount: Amount.fromMajor(400) }],
      });

      // Cash asset: 1000 - 400 = 600
      expect(formatAmount(await ledger.balanceByType(AccountType.Asset))).toBe(
        "600.00",
      );
      // Equity: Common Stock 1000 minus contra Drawing 400 = 600
      expect(formatAmount(await ledger.balanceByType(AccountType.Equity))).toBe(
        "600.00",
      );
      // Assets == Liabilities + Equity
      const bs = await ledger.balanceSheet();
      expect(bs.imbalance).toBe(0n);
    });
  });

  describe("trialBalance", () => {
    it("is zero with no entries", async () => {
      expect(await ledger.trialBalance()).toBe(0n);
    });

    /**
     * Mirrors the Ruby `account_spec.rb` trial balance matrix: all 5 account
     * types plus 4 contra variants, posted as balanced entries, must net to 0.
     */
    it("is zero with balanced entries across all types and contra variants", async () => {
      const liability = await ledger.createAccount({
        name: "Liab",
        type: AccountType.Liability,
      });
      const equity = await ledger.createAccount({
        name: "Equity",
        type: AccountType.Equity,
      });
      const revenue = await ledger.createAccount({
        name: "Rev",
        type: AccountType.Revenue,
      });
      const contraAsset = await ledger.createAccount({
        name: "CAsset",
        type: AccountType.Asset,
        contra: true,
      });
      const contraExpense = await ledger.createAccount({
        name: "CExp",
        type: AccountType.Expense,
        contra: true,
      });

      const asset = await ledger.createAccount({
        name: "Asset",
        type: AccountType.Asset,
      });
      const expense = await ledger.createAccount({
        name: "Exp",
        type: AccountType.Expense,
      });
      const contraLiability = await ledger.createAccount({
        name: "CLiab",
        type: AccountType.Liability,
        contra: true,
      });
      const contraEquity = await ledger.createAccount({
        name: "CEq",
        type: AccountType.Equity,
        contra: true,
      });
      const contraRevenue = await ledger.createAccount({
        name: "CRev",
        type: AccountType.Revenue,
        contra: true,
      });

      const cases: [Account, Account, number][] = [
        [liability, asset, 100000],
        [equity, expense, 1000],
        [revenue, contraLiability, 40404],
        [contraAsset, contraEquity, 2],
        [contraExpense, contraRevenue, 333],
      ];
      for (const [creditAcc, debitAcc, amount] of cases) {
        await ledger.postEntry({
          description: "entry",
          debits: [{ account: debitAcc, amount: Amount.fromMajor(amount) }],
          credits: [{ account: creditAcc, amount: Amount.fromMajor(amount) }],
        });
      }

      expect(await ledger.trialBalance()).toBe(0n);
    });

    /**
     * A point-in-time trial balance (entries up to a date) must still net to
     * zero: every balanced entry is self-cancelling across account types.
     * F-09: the parameter is an as-of date, not a range — a "from-scoped"
     * trial balance is not a statement an accountant can name.
     */
    it("is zero as of any date", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      await ledger.createAccount({
        name: "Expense",
        type: AccountType.Expense,
      });

      await ledger.postEntry({
        description: "Earn",
        date: "2024-01-15",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      });
      await ledger.postEntry({
        description: "Spend",
        date: "2024-06-15",
        debits: [{ accountName: "Expense", amount: Amount.fromMajor(30) }],
        credits: [{ accountName: "Cash", amount: Amount.fromMajor(30) }],
      });

      expect(await ledger.trialBalance()).toBe(0n);
      expect(await ledger.trialBalance("2024-02-01")).toBe(0n);
      expect(await ledger.trialBalance(new Date("2024-12-31"))).toBe(0n);
    });
  });

  describe("trialBalanceReport", () => {
    it("lists each account in debit/credit columns with equal totals", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({ name: "Equity", type: AccountType.Equity });
      await ledger.createAccount({ name: "Exp", type: AccountType.Expense });

      await ledger.postEntry({
        description: "Invest",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(1000) }],
        credits: [{ accountName: "Equity", amount: Amount.fromMajor(1000) }],
      });
      await ledger.postEntry({
        description: "Spend",
        debits: [{ accountName: "Exp", amount: Amount.fromMajor(400) }],
        credits: [{ accountName: "Cash", amount: Amount.fromMajor(400) }],
      });

      const report = await ledger.trialBalanceReport();
      const byName = new Map(report.rows.map((r) => [r.account.name, r]));
      // Cash: 1000 dr - 400 cr = 600 debit-column balance.
      expect(byName.get("Cash")?.debit).toBe(60000n);
      expect(byName.get("Cash")?.credit).toBe(0n);
      // Equity: 1000 credit-column balance.
      expect(byName.get("Equity")?.debit).toBe(0n);
      expect(byName.get("Equity")?.credit).toBe(100000n);
      // Expense: 400 debit-column balance.
      expect(byName.get("Exp")?.debit).toBe(40000n);
      // The proof: total debits === total credits.
      expect(report.totalDebits).toBe(report.totalCredits);
      expect(report.totalDebits).toBe(100000n);
      expect(report.balanced).toBe(true);
    });
  });

  describe("reports", () => {
    // F-09: a balance sheet is point-in-time — cumulative from inception to
    // an as-of date. The old DateRange parameter allowed a fromDate-scoped
    // "balance sheet" of period deltas, which is not a balance sheet.
    it("reports cumulative balances as of a date", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({ name: "Equity", type: AccountType.Equity });
      await ledger.createAccount({ name: "Exp", type: AccountType.Expense });
      await ledger.postEntry({
        description: "Invest",
        date: "2024-01-10",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(500) }],
        credits: [{ accountName: "Equity", amount: Amount.fromMajor(500) }],
      });
      await ledger.postEntry({
        description: "Spend",
        date: "2024-02-10",
        debits: [{ accountName: "Exp", amount: Amount.fromMajor(200) }],
        credits: [{ accountName: "Cash", amount: Amount.fromMajor(200) }],
      });

      const asOfJan = await ledger.balanceSheet("2024-01-31");
      expect(formatAmount(asOfJan.assets)).toBe("500.00");
      expect(asOfJan.imbalance).toBe(0n);

      const latest = await ledger.balanceSheet();
      expect(formatAmount(latest.assets)).toBe("300.00");
      expect(latest.imbalance).toBe(0n);
    });

    it("produces a balance sheet that balances", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({ name: "Equity", type: AccountType.Equity });
      await ledger.postEntry({
        description: "Invest",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(500) }],
        credits: [{ accountName: "Equity", amount: Amount.fromMajor(500) }],
      });
      const bs = await ledger.balanceSheet();
      expect(formatAmount(bs.assets)).toBe("500.00");
      expect(formatAmount(bs.equity)).toBe("500.00");
      expect(bs.imbalance).toBe(0n);
    });

    it("reconciles the accounting equation from returned fields when net income exists", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({ name: "Equity", type: AccountType.Equity });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      await ledger.createAccount({ name: "Exp", type: AccountType.Expense });
      // Earn revenue 300 (Cash dr / Revenue cr) and incur expense 100
      // (Exp dr / Cash cr): net income of 200 lives outside `equity`.
      await ledger.postEntry({
        description: "Earn",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(300) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(300) }],
      });
      await ledger.postEntry({
        description: "Spend",
        debits: [{ accountName: "Exp", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
      });

      const bs = await ledger.balanceSheet();
      expect(formatAmount(bs.netIncome)).toBe("200.00");
      // The equation reconciles using only the returned fields — no consumer
      // needs to fetch the income statement separately to make it add up.
      expect(bs.assets).toBe(bs.liabilities + bs.equity + bs.netIncome);
      expect(bs.imbalance).toBe(0n);
    });

    it("produces an income statement", async () => {
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      await ledger.createAccount({
        name: "Expense",
        type: AccountType.Expense,
      });
      await ledger.postEntry({
        description: "Earn",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(300) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(300) }],
      });
      await ledger.postEntry({
        description: "Spend",
        debits: [{ accountName: "Expense", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
      });
      const is = await ledger.incomeStatement();
      expect(formatAmount(is.revenue)).toBe("300.00");
      expect(formatAmount(is.expenses)).toBe("100.00");
      expect(formatAmount(is.netIncome)).toBe("200.00");
    });
  });

  describe("account associations", () => {
    it("returns all amounts and entries for an account", async () => {
      const equity = await ledger.createAccount({
        name: "Equity",
        type: AccountType.Equity,
      });
      const asset = await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      const expense = await ledger.createAccount({
        name: "Exp",
        type: AccountType.Expense,
      });

      await ledger.postEntry({
        description: "Invest",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(1000) }],
        credits: [{ accountName: "Equity", amount: Amount.fromMajor(1000) }],
      });
      await ledger.postEntry({
        description: "Buy computer",
        debits: [{ accountName: "Exp", amount: Amount.fromMajor(900) }],
        credits: [{ accountName: "Cash", amount: Amount.fromMajor(900) }],
      });

      expect((await ledger.amountsForAccount(equity)).length).toBe(1);
      expect((await ledger.amountsForAccount(asset)).length).toBe(2);
      expect((await ledger.amountsForAccount(expense)).length).toBe(1);

      expect((await ledger.entriesForAccount(equity)).length).toBe(1);
      expect((await ledger.entriesForAccount(asset)).length).toBe(2);
      expect((await ledger.entriesForAccount(expense)).length).toBe(1);
    });
  });
});
