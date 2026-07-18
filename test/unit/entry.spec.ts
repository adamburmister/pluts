import { describe, expect, it } from "vitest";
import { Account } from "../../src/domain/account";
import { Amount } from "../../src/domain/amount";
import { buildEntry, computeEntryFingerprint } from "../../src/domain/entry";
import { ValidationError, type ValidationIssue } from "../../src/domain/errors";
import type { EntryInput } from "../../src/domain/schemas";
import { AccountType } from "../../src/domain/types";

function acct(name: string, type = AccountType.Asset): Account {
  return new Account(`id-${name}`, name, type, false, "");
}

function baseInput(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    description: "Sold some widgets",
    debits: [
      {
        account: acct("Cash", AccountType.Asset),
        amount: Amount.fromMajor(100),
      },
    ],
    credits: [
      {
        account: acct("Revenue", AccountType.Revenue),
        amount: Amount.fromMajor(100),
      },
    ],
    ...overrides,
  };
}

function issuesFor(input: EntryInput, resolve = () => null): ValidationIssue[] {
  try {
    buildEntry(input, resolve);
    return [];
  } catch (e) {
    if (e instanceof ValidationError) return e.issues;
    throw e;
  }
}

function messagesFor(
  root: string,
  input: EntryInput,
  resolve = () => null,
): string[] {
  return issuesFor(input, resolve)
    .filter((i) => i.path.length > 0 && i.path[0] === root)
    .map((i) => i.message);
}

describe("buildEntry", () => {
  it("is valid with matching debit and credit", () => {
    const payload = buildEntry(baseInput(), () => null);
    expect(payload.debits).toHaveLength(1);
    expect(payload.credits).toHaveLength(1);
    expect(payload.description).toBe("Sold some widgets");
  });

  it("requires a description", () => {
    const msgs = issuesFor(baseInput({ description: "" }));
    expect(msgs.some((m) => m.path[0] === "description")).toBe(true);
  });

  it("rejects an empty debits array", () => {
    const msgs = messagesFor("debits", baseInput({ debits: [] }));
    expect(msgs).toContain("Entry must have at least one debit amount");
  });

  it("rejects an empty credits array", () => {
    const msgs = messagesFor("credits", baseInput({ credits: [] }));
    expect(msgs).toContain("Entry must have at least one credit amount");
  });

  it("rejects a missing amount", () => {
    const msgs = issuesFor({
      description: "x",
      debits: [{ account: acct("Cash") }],
      credits: [
        {
          account: acct("Rev", AccountType.Revenue),
          amount: Amount.fromMajor(10),
        },
      ],
    } as unknown as EntryInput);
    expect(
      msgs.some(
        (m) => m.message.includes("amount") || m.path.includes("amount"),
      ),
    ).toBe(true);
  });

  it("rejects when debit and credit do not cancel", () => {
    const msgs = issuesFor(
      baseInput({
        debits: [{ account: acct("Cash"), amount: Amount.fromMajor(200) }],
        credits: [
          {
            account: acct("Rev", AccountType.Revenue),
            amount: Amount.fromMajor(100),
          },
        ],
      }),
    );
    expect(msgs.some((m) => m.path.length === 0)).toBe(true);
    expect(
      msgs.some(
        (m) => m.message === "The credit and debit amounts are not equal",
      ),
    ).toBe(true);
  });

  it("rejects fractional mismatches exactly (100.10 vs 100.20)", () => {
    const msgs = issuesFor(
      baseInput({
        debits: [{ account: acct("Cash"), amount: Amount.fromMajor("100.10") }],
        credits: [
          {
            account: acct("Rev", AccountType.Revenue),
            amount: Amount.fromMajor("100.20"),
          },
        ],
      }),
    );
    expect(
      msgs.some(
        (m) => m.message === "The credit and debit amounts are not equal",
      ),
    ).toBe(true);
  });

  it("accepts multiple credits summing to the debit total", () => {
    const payload = buildEntry(
      baseInput({
        debits: [{ account: acct("AR"), amount: Amount.fromMajor(50) }],
        credits: [
          {
            account: acct("Sales", AccountType.Revenue),
            amount: Amount.fromMajor(45),
          },
          {
            account: acct("Tax", AccountType.Liability),
            amount: Amount.fromMajor(5),
          },
        ],
      }),
    );
    expect(payload.credits).toHaveLength(2);
  });

  it("defaults the date to today when omitted", () => {
    const fixed = new Date("2026-07-06T00:00:00Z");
    const payload = buildEntry(
      baseInput(),
      () => null,
      () => fixed,
    );
    expect(payload.date).toBe("2026-07-06");
  });

  it("uses the provided date string", () => {
    const payload = buildEntry(baseInput({ date: "2024-01-15" }), () => null);
    expect(payload.date).toBe("2024-01-15");
  });

  // F-02: dates are compared lexicographically in range queries, so anything
  // other than strict zero-padded yyyy-mm-dd silently falls out of (or into)
  // the wrong reporting period. Malformed dates must be rejected, not stored.
  it("rejects a non-zero-padded date string", () => {
    const msgs = issuesFor(baseInput({ date: "2026-1-5" }));
    expect(msgs.some((m) => m.path.includes("date"))).toBe(true);
  });

  it("rejects a non-date string", () => {
    const msgs = issuesFor(baseInput({ date: "not-a-date" }));
    expect(msgs.some((m) => m.path.includes("date"))).toBe(true);
  });

  it("rejects an impossible calendar date", () => {
    const msgs = issuesFor(baseInput({ date: "2026-02-30" }));
    expect(msgs.some((m) => m.path.includes("date"))).toBe(true);
  });

  it("rejects an invalid Date object", () => {
    const msgs = issuesFor(baseInput({ date: new Date("garbage") }));
    expect(msgs.some((m) => m.path.includes("date"))).toBe(true);
  });

  it("resolves accounts by name via the resolver", () => {
    const cash = acct("Cash");
    const rev = acct("Revenue", AccountType.Revenue);
    const payload = buildEntry(
      {
        description: "x",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(10) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(10) }],
      },
      (name) => (name === "Cash" ? cash : name === "Revenue" ? rev : null),
    );
    const [debit] = payload.debits;
    if (!debit) throw new Error("no debit");
    const [credit] = payload.credits;
    if (!credit) throw new Error("no credit");
    expect(debit.account.name).toBe("Cash");
    expect(credit.account.name).toBe("Revenue");
  });

  it("reports an error for an unknown account name", () => {
    const msgs = issuesFor(
      {
        description: "x",
        debits: [{ accountName: "Ghost", amount: Amount.fromMajor(10) }],
        credits: [
          {
            account: acct("Revenue", AccountType.Revenue),
            amount: Amount.fromMajor(10),
          },
        ],
      },
      () => null,
    );
    expect(msgs.some((m) => m.message === 'Account "Ghost" not found')).toBe(
      true,
    );
  });

  it("accepts raw number amounts (Zod transform)", () => {
    const payload = buildEntry({
      description: "x",
      debits: [{ account: acct("Cash"), amount: 100 }],
      credits: [
        { account: acct("Rev", AccountType.Revenue), amount: "100.00" },
      ],
    });
    const [debit] = payload.debits;
    if (!debit) throw new Error("no debit");
    const [credit] = payload.credits;
    if (!credit) throw new Error("no credit");
    expect(debit.amount.toMajor()).toBe("100.00");
    expect(credit.amount.toMajor()).toBe("100.00");
  });
});

describe("computeEntryFingerprint", () => {
  // A retry of a date-less request is still the same request even if it
  // arrives after a UTC day rollover: the fingerprint must hash what the
  // caller sent (date omitted), not the day the retry happened to land on.
  // Otherwise a delayed retry throws IdempotencyConflictError instead of
  // returning the original entry.
  it("is stable across a day boundary when the caller omitted the date", async () => {
    const input = baseInput({ idempotencyKey: "req-1" });
    const day1 = buildEntry(
      input,
      () => null,
      () => new Date("2026-07-05T23:59:59Z"),
    );
    const day2 = buildEntry(
      input,
      () => null,
      () => new Date("2026-07-06T00:00:01Z"),
    );
    expect(day1.date).toBe("2026-07-05");
    expect(day2.date).toBe("2026-07-06");
    expect(await computeEntryFingerprint(day2)).toBe(
      await computeEntryFingerprint(day1),
    );
  });

  it("distinguishes explicitly different dates", async () => {
    const a = buildEntry(baseInput({ date: "2026-01-05" }));
    const b = buildEntry(baseInput({ date: "2026-01-06" }));
    expect(await computeEntryFingerprint(a)).not.toBe(
      await computeEntryFingerprint(b),
    );
  });
});
