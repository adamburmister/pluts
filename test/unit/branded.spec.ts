import { describe, expect, expectTypeOf, it } from "vitest";
import type { Repository } from "../../src/db/repository";
import type { Account } from "../../src/domain/account";
import type {
  AccountId,
  AmountLineId,
  EntryId,
  IdempotencyKey,
  ISODate,
} from "../../src/domain/branded";
import {
  toAccountId,
  toAmountLineId,
  toEntryId,
  toIdempotencyKey,
} from "../../src/domain/branded";
import type { AccountDTO, AmountLineDTO, EntryDTO } from "../../src/domain/dto";
import type { Entry } from "../../src/domain/entry";

// Issue #31: primitive obsession. Every identifier was a bare `string`, so an
// account id could be passed where an entry id was expected and typecheck
// silently. These brands make such swaps a compile error. The tests below fail
// `npm run typecheck` the moment two brands become interchangeable — the core
// guarantee the refactor exists to provide.

describe("branded identifier types are mutually non-assignable", () => {
  it("AccountId is not assignable to EntryId (or vice versa)", () => {
    expectTypeOf<AccountId>().not.toExtend<EntryId>();
    expectTypeOf<EntryId>().not.toExtend<AccountId>();
  });

  it("AccountId is not assignable to AmountLineId / IdempotencyKey / ISODate", () => {
    expectTypeOf<AccountId>().not.toExtend<AmountLineId>();
    expectTypeOf<AccountId>().not.toExtend<IdempotencyKey>();
    expectTypeOf<AccountId>().not.toExtend<ISODate>();
  });

  it("EntryId is not assignable to AmountLineId / IdempotencyKey / ISODate", () => {
    expectTypeOf<EntryId>().not.toExtend<AmountLineId>();
    expectTypeOf<EntryId>().not.toExtend<IdempotencyKey>();
    expectTypeOf<EntryId>().not.toExtend<ISODate>();
  });

  it("ISODate is not assignable to AccountId / EntryId", () => {
    expectTypeOf<ISODate>().not.toExtend<AccountId>();
    expectTypeOf<ISODate>().not.toExtend<EntryId>();
  });

  it("a bare string is not assignable to any brand (the whole point)", () => {
    expectTypeOf<string>().not.toExtend<AccountId>();
    expectTypeOf<string>().not.toExtend<EntryId>();
    expectTypeOf<string>().not.toExtend<ISODate>();
  });

  it("brands remain strings underneath (so they cost nothing at runtime)", () => {
    expectTypeOf<AccountId>().toExtend<string>();
    expectTypeOf<EntryId>().toExtend<string>();
    expectTypeOf<ISODate>().toExtend<string>();
  });
});

describe("the public surface actually carries the brands", () => {
  it("Account.id is an AccountId and Entry.id is an EntryId", () => {
    expectTypeOf<Account["id"]>().toEqualTypeOf<AccountId>();
    expectTypeOf<Entry["id"]>().toEqualTypeOf<EntryId>();
  });

  it("Repository methods take branded ids", () => {
    expectTypeOf<
      Parameters<Repository["getAccount"]>[0]
    >().toEqualTypeOf<AccountId>();
    expectTypeOf<
      Parameters<Repository["getEntry"]>[0]
    >().toEqualTypeOf<EntryId>();
    expectTypeOf<
      Parameters<Repository["amountsForAccount"]>[0]
    >().toEqualTypeOf<AccountId>();
  });

  it("DTOs expose branded id fields", () => {
    expectTypeOf<AccountDTO["id"]>().toEqualTypeOf<AccountId>();
    expectTypeOf<EntryDTO["id"]>().toEqualTypeOf<EntryId>();
    expectTypeOf<EntryDTO["date"]>().toEqualTypeOf<ISODate>();
    expectTypeOf<AmountLineDTO["entryId"]>().toEqualTypeOf<EntryId>();
  });
});

describe("brand helpers are zero-cost identity casts", () => {
  it("return the same string with no transformation", () => {
    expect(toAccountId("acc-1")).toBe("acc-1");
    expect(toEntryId("entry-1")).toBe("entry-1");
    expect(toAmountLineId("line-1")).toBe("line-1");
    expect(toIdempotencyKey("key-1")).toBe("key-1");
  });
});
