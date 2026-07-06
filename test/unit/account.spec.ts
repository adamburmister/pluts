import { describe, expect, it } from "vitest";
import { aggregateBalances, computeBalance } from "../../src/domain/account";
import { Amount } from "../../src/domain/amount";
import { AccountType } from "../../src/domain/types";

/**
 * Ports the Ruby `spec/support/account_shared_examples.rb` behaviour:
 * for each subtype, a debit should push the balance in the direction of the
 * normal balance, and a credit the opposite; contra inverts both.
 */
function subtypeBalanceCases(
  type: AccountType,
  normalBalance: "debit" | "credit",
) {
  const debitSign = normalBalance === "debit" ? 1 : -1;
  const creditSign = normalBalance === "credit" ? 1 : -1;

  it(`debit increases balance for ${type}`, () => {
    const bal = computeBalance(
      type,
      false,
      Amount.zero(),
      Amount.fromMajor(100),
    );
    expect(bal).toBe(BigInt(debitSign) * 10000n);
  });

  it(`credit increases balance for ${type}`, () => {
    const bal = computeBalance(
      type,
      false,
      Amount.fromMajor(100),
      Amount.zero(),
    );
    expect(bal).toBe(BigInt(creditSign) * 10000n);
  });

  it(`contra inverts the debit effect for ${type}`, () => {
    const bal = computeBalance(
      type,
      true,
      Amount.zero(),
      Amount.fromMajor(100),
    );
    expect(bal).toBe(BigInt(-debitSign) * 10000n);
  });

  it(`contra inverts the credit effect for ${type}`, () => {
    const bal = computeBalance(
      type,
      true,
      Amount.fromMajor(100),
      Amount.zero(),
    );
    expect(bal).toBe(BigInt(-creditSign) * 10000n);
  });
}

describe("computeBalance", () => {
  describe("Asset (normal debit)", () =>
    subtypeBalanceCases(AccountType.Asset, "debit"));
  describe("Expense (normal debit)", () =>
    subtypeBalanceCases(AccountType.Expense, "debit"));
  describe("Liability (normal credit)", () =>
    subtypeBalanceCases(AccountType.Liability, "credit"));
  describe("Equity (normal credit)", () =>
    subtypeBalanceCases(AccountType.Equity, "credit"));
  describe("Revenue (normal credit)", () =>
    subtypeBalanceCases(AccountType.Revenue, "credit"));
});

describe("aggregateBalances", () => {
  it("sums non-contra accounts of the type", () => {
    const accounts = [
      { type: AccountType.Asset, contra: false, balance: 10000n },
      { type: AccountType.Asset, contra: false, balance: 5000n },
      { type: AccountType.Liability, contra: false, balance: 99900n },
    ];
    expect(aggregateBalances(accounts, AccountType.Asset)).toBe(15000n);
  });

  it("subtracts contra accounts", () => {
    const accounts = [
      { type: AccountType.Asset, contra: false, balance: 10000n },
      { type: AccountType.Asset, contra: true, balance: 3000n },
    ];
    expect(aggregateBalances(accounts, AccountType.Asset)).toBe(7000n);
  });

  it("returns zero when no accounts of the type", () => {
    expect(aggregateBalances([], AccountType.Asset)).toBe(0n);
  });
});
