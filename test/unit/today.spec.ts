import { describe, expect, it } from "vitest";
import { Account } from "../../src/domain/account";
import { Amount } from "../../src/domain/amount";
import { buildEntry } from "../../src/domain/entry";
import { Ledger } from "../../src/domain/ledger";
import type { EntryInput } from "../../src/domain/schemas";
import { AccountType, todayInTimeZone, utcToday } from "../../src/domain/types";
import { InMemoryRepository } from "../helpers/in-memory-repository";

function acct(name: string, type = AccountType.Asset): Account {
  return new Account(`id-${name}`, name, type, false, "");
}

function baseInput(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    description: "Sold some widgets",
    debits: [{ account: acct("Cash"), amount: Amount.fromMajor(100) }],
    credits: [
      {
        account: acct("Revenue", AccountType.Revenue),
        amount: Amount.fromMajor(100),
      },
    ],
    ...overrides,
  };
}

// Issue #25: the documented default is the *UTC* calendar day. An NZ-local
// same-evening pair (2026-07-20 11:30am and 1:30pm NZST) straddles two UTC
// dates, so it also straddles two reporting months' boundaries at month end.
describe("default transaction date (UTC policy)", () => {
  it("uses the UTC calendar day, so a same-evening NZ pair spans two dates", () => {
    const before = buildEntry(
      baseInput(),
      () => null,
      () => utcToday(new Date("2026-07-19T23:30:00Z")),
    );
    const after = buildEntry(
      baseInput(),
      () => null,
      () => utcToday(new Date("2026-07-20T01:30:00Z")),
    );
    expect(before.date).toBe("2026-07-19");
    expect(after.date).toBe("2026-07-20");
  });

  it("marks the defaulted date so the idempotency fingerprint ignores it", () => {
    const payload = buildEntry(
      baseInput(),
      () => null,
      () => "2026-07-19",
    );
    expect(payload.dateWasDefaulted).toBe(true);
  });

  it("never overrides an explicit date", () => {
    const payload = buildEntry(
      baseInput({ date: "2026-01-05" }),
      () => null,
      () => utcToday(new Date("2026-07-20T01:30:00Z")),
    );
    expect(payload.date).toBe("2026-01-05");
    expect(payload.dateWasDefaulted).toBeUndefined();
  });
});

describe("todayInTimeZone", () => {
  it("resolves the local calendar day, not the UTC one", () => {
    const at = new Date("2026-07-19T23:30:00Z");
    expect(todayInTimeZone("Pacific/Auckland")(at)).toBe("2026-07-20");
    expect(todayInTimeZone("UTC")(at)).toBe("2026-07-19");
    expect(todayInTimeZone("America/Los_Angeles")(at)).toBe("2026-07-19");
  });

  it("zero-pads single-digit months and days", () => {
    expect(todayInTimeZone("UTC")(new Date("2026-01-05T00:00:00Z"))).toBe(
      "2026-01-05",
    );
  });

  it("rejects an unknown time zone eagerly, at construction", () => {
    expect(() => todayInTimeZone("Mars/Olympus_Mons")).toThrow(RangeError);
  });
});

describe("Ledger today option", () => {
  it("defaults an omitted entry date using the injected today()", async () => {
    const ledger = new Ledger(new InMemoryRepository(), {
      today: () => "2026-07-20",
    });
    await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });
    const entry = await ledger.postEntry({
      description: "Sale",
      debits: [{ accountName: "Cash", amount: 100 }],
      credits: [{ accountName: "Revenue", amount: 100 }],
    });
    expect(entry.date).toBe("2026-07-20");
  });

  it("falls back to the UTC day when no option is supplied", async () => {
    const ledger = new Ledger(new InMemoryRepository());
    await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });
    const entry = await ledger.postEntry({
      description: "Sale",
      debits: [{ accountName: "Cash", amount: 100 }],
      credits: [{ accountName: "Revenue", amount: 100 }],
    });
    expect(entry.date).toBe(utcToday());
  });

  it("rejects a today() that returns a non-ISO date", async () => {
    const ledger = new Ledger(new InMemoryRepository(), {
      today: () => "20/07/2026",
    });
    await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });
    await expect(
      ledger.postEntry({
        description: "Sale",
        debits: [{ accountName: "Cash", amount: 100 }],
        credits: [{ accountName: "Revenue", amount: 100 }],
      }),
    ).rejects.toThrow(RangeError);
  });
});
