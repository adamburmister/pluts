import { describe, expect, it } from "vitest";
import { Account } from "../../src/domain/account";
import { Amount } from "../../src/domain/amount";
import type { ISODate } from "../../src/domain/branded";
import {
  toAccountId,
  toAmountLineId,
  toEntryId,
} from "../../src/domain/branded";
import {
  toAccountDTO,
  toAmountLineDTO,
  toEntryDTO,
} from "../../src/domain/dto";
import { AmountRecord, Entry } from "../../src/domain/entry";
import { AccountType } from "../../src/domain/types";

const iso = (s: string): ISODate => s as ISODate;

function acct(name: string, type = AccountType.Asset): Account {
  return new Account(
    toAccountId(`id-${name}`),
    name,
    type,
    false,
    iso("2026-01-01"),
  );
}

/** Build an Entry whose lines carry real Amount instances (the RPC bug case). */
function entry(): Entry {
  const cash = acct("Cash", AccountType.Asset);
  const revenue = acct("Revenue", AccountType.Revenue);
  return new Entry(
    toEntryId("entry-1"),
    "Sold some widgets",
    iso("2026-07-01"),
    [
      new AmountRecord(
        toAmountLineId("aline-1"),
        "debit",
        cash,
        Amount.fromMajor("100.00"),
        toEntryId("entry-1"),
      ),
    ],
    [
      new AmountRecord(
        toAmountLineId("aline-2"),
        "credit",
        revenue,
        Amount.fromMajor("100.00"),
        toEntryId("entry-1"),
      ),
    ],
    iso("2026-07-01T10:00:00.000Z"),
  );
}

describe("DTO serialization", () => {
  it("structuredClone of toEntryDTO round-trips and deep-equals (RPC regression)", () => {
    const dto = toEntryDTO(entry());
    const cloned = structuredClone(dto);
    expect(cloned).toEqual(dto);
  });

  it("JSON.stringify of toEntryDTO does not throw", () => {
    expect(() => JSON.stringify(toEntryDTO(entry()))).not.toThrow();
  });

  it("JSON.stringify of structuredClone(toAccountDTO) does not throw", () => {
    const dto = toAccountDTO(acct("Cash"));
    expect(() => JSON.stringify(structuredClone(dto))).not.toThrow();
  });

  it("JSON.stringify of structuredClone(toAmountLineDTO) does not throw", () => {
    const line = new AmountRecord(
      toAmountLineId("aline-1"),
      "debit",
      acct("Cash"),
      Amount.fromMajor("100.00"),
      toEntryId("entry-1"),
    );
    expect(() =>
      JSON.stringify(structuredClone(toAmountLineDTO(line))),
    ).not.toThrow();
  });

  it("structuredClone of a raw Entry (Amount lines) throws or loses Amount prototype", () => {
    const raw = entry();
    let threw = false;
    let clone: unknown;
    try {
      clone = structuredClone(raw);
    } catch {
      threw = true;
    }
    if (threw) {
      expect(threw).toBe(true);
      return;
    }
    // Node's structuredClone may accept class instances as opaque records;
    // workerd is stricter. If no throw, the Amount prototype must be gone.
    const clonedEntry = clone as { debitAmounts: { amount: unknown }[] };
    const amount = clonedEntry.debitAmounts[0]?.amount;
    expect(amount instanceof Amount).toBe(false);
  });

  it("formats Amounts through the DTO path", () => {
    const cases: [string, string][] = [
      ["0", "0.00"],
      ["0.99", "0.99"],
      ["0.005", "0.01"],
      ["0.004", "0.00"],
      ["1000000", "1000000.00"],
      ["123.4", "123.40"],
      ["1.235", "1.24"],
    ];
    for (const [input, expected] of cases) {
      const line = new AmountRecord(
        toAmountLineId("l"),
        "debit",
        acct("Cash"),
        Amount.fromMajor(input),
        toEntryId("e"),
      );
      expect(toAmountLineDTO(line).amount).toBe(expected);
    }
  });

  it("AccountDTO omits the optional balance by default", () => {
    const dto = toAccountDTO(acct("Cash"));
    expect(dto.balance).toBeUndefined();
  });

  // F-16: one concept, one wire shape. AmountRecord.toJSON used to emit
  // { accountId } while Entry.toJSON spread the same records into
  // { account: {...} } — two different serializations of the same line.
  // Both now delegate to the DTO mappers.
  it("JSON of an AmountRecord matches its DTO shape", () => {
    const line = new AmountRecord(
      toAmountLineId("aline-1"),
      "debit",
      acct("Cash"),
      Amount.fromMajor("100.00"),
      toEntryId("entry-1"),
    );
    expect(JSON.parse(JSON.stringify(line))).toEqual(
      JSON.parse(JSON.stringify(toAmountLineDTO(line))),
    );
  });

  it("JSON of an Entry matches its DTO shape", () => {
    const e = entry();
    expect(JSON.parse(JSON.stringify(e))).toEqual(
      JSON.parse(JSON.stringify(toEntryDTO(e))),
    );
  });

  // F-16: readonly arrays were compile-time only — a runtime push succeeded.
  it("entry line arrays are frozen at runtime", () => {
    const e = entry();
    expect(() =>
      (e.debitAmounts as unknown as unknown[]).push("tampered"),
    ).toThrow(TypeError);
    expect(e.debitAmounts).toHaveLength(1);
  });
});
