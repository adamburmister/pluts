import { describe, expect, it } from "vitest";
import { Account } from "../../src/domain/account";
import { Amount } from "../../src/domain/amount";
import { assertBalanced, type EntryPayload } from "../../src/domain/entry";
import { ValidationError } from "../../src/domain/errors";
import { AccountType } from "../../src/domain/types";
import { InMemoryRepository } from "../helpers/in-memory-repository";

function acct(name: string, type = AccountType.Asset): Account {
  return new Account(`id-${name}`, name, type, false, "");
}

function payload(overrides: Partial<EntryPayload> = {}): EntryPayload {
  return {
    description: "test entry",
    date: "2026-01-01",
    debits: [{ account: acct("Cash"), amount: Amount.fromMajor(100) }],
    credits: [
      {
        account: acct("Rev", AccountType.Revenue),
        amount: Amount.fromMajor(100),
      },
    ],
    ...overrides,
  };
}

/**
 * F-03: the balance invariant lived only in the Ledger facade's input schema.
 * EntryPayload is a structural interface, so any caller (or a third-party
 * Repository port following the README's guidance) could hand-construct an
 * unbalanced payload and persist it, silently breaking the accounting
 * equation for the whole ledger. The invariant must hold at the persistence
 * seam, not just at the facade.
 */
describe("assertBalanced", () => {
  it("accepts a balanced payload", () => {
    expect(() => assertBalanced(payload())).not.toThrow();
  });

  it("rejects unequal debit and credit totals", () => {
    const p = payload({
      credits: [
        {
          account: acct("Rev", AccountType.Revenue),
          amount: Amount.fromMajor(1),
        },
      ],
    });
    expect(() => assertBalanced(p)).toThrow(ValidationError);
  });

  it("rejects a payload with no debits", () => {
    const p = payload({ debits: [] });
    expect(() => assertBalanced(p)).toThrow(ValidationError);
  });

  it("rejects a payload with no credits", () => {
    const p = payload({ credits: [] });
    expect(() => assertBalanced(p)).toThrow(ValidationError);
  });

  // F-13's "every line must move money" must hold at the persistence seam
  // too: a balanced payload with an extra zero leg passed only the facade's
  // schema, so hand-constructed payloads could persist zero lines.
  it("rejects a balanced payload containing a zero-amount line", () => {
    const p = payload({
      debits: [
        { account: acct("Cash"), amount: Amount.fromMajor(10) },
        { account: acct("Bank"), amount: Amount.zero() },
      ],
      credits: [
        {
          account: acct("Rev", AccountType.Revenue),
          amount: Amount.fromMajor(10),
        },
      ],
    });
    expect(() => assertBalanced(p)).toThrow(ValidationError);
  });

  it("rejects an all-zero payload", () => {
    const p = payload({
      debits: [{ account: acct("Cash"), amount: Amount.zero() }],
      credits: [
        { account: acct("Rev", AccountType.Revenue), amount: Amount.zero() },
      ],
    });
    expect(() => assertBalanced(p)).toThrow(ValidationError);
  });
});

describe("Repository.insertEntry enforces the balance invariant", () => {
  it("rejects an unbalanced payload and persists nothing", async () => {
    const repo = new InMemoryRepository();
    const cash = await repo.insertAccount({
      name: "Cash",
      type: AccountType.Asset,
      contra: false,
    });
    const rev = await repo.insertAccount({
      name: "Revenue",
      type: AccountType.Revenue,
      contra: false,
    });

    await expect(
      repo.insertEntry({
        description: "unbalanced",
        date: "2026-01-01",
        debits: [{ account: cash, amount: Amount.fromMajor(100) }],
        credits: [{ account: rev, amount: Amount.fromMajor(1) }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // No partial write: nothing recorded anywhere.
    expect(await repo.allEntries()).toHaveLength(0);
    expect((await repo.sumDebits(cash.id)).isZero()).toBe(true);
    expect((await repo.sumCredits(rev.id)).isZero()).toBe(true);
  });

  it("rejects a one-sided payload (no credits)", async () => {
    const repo = new InMemoryRepository();
    const cash = await repo.insertAccount({
      name: "Cash",
      type: AccountType.Asset,
      contra: false,
    });

    await expect(
      repo.insertEntry({
        description: "one-sided",
        date: "2026-01-01",
        debits: [{ account: cash, amount: Amount.fromMajor(50) }],
        credits: [],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await repo.allEntries()).toHaveLength(0);
  });
});
