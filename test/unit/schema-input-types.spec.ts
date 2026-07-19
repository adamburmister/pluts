import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type {
  AmountInput,
  amountLineSchema,
  CreateAccountInput,
  createAccountSchema,
  EntryInput,
  entryInputSchema,
} from "../../src/domain/schemas";

// Zod is an implementation detail of the public API (issue #32): consumers
// depend on the hand-written input interfaces, not on zod's inference. Those
// interfaces are only safe to hand-maintain if they cannot silently drift from
// the schemas that actually parse the input. The assertions below fail
// `npm run typecheck` the moment a schema and its interface disagree.
//
// The check is bidirectional assignability rather than `toEqualTypeOf` because
// zod's `.default()` inputs are structurally equal but not *identically*
// branded; mutual assignability is the property that actually matters — it
// catches any added, removed, or retyped field in either direction.
describe("public input interfaces stay in sync with their zod schemas", () => {
  it("AmountInput matches amountLineSchema's input", () => {
    expectTypeOf<AmountInput>().toExtend<z.input<typeof amountLineSchema>>();
    expectTypeOf<z.input<typeof amountLineSchema>>().toExtend<AmountInput>();
  });

  it("CreateAccountInput matches createAccountSchema's input", () => {
    expectTypeOf<CreateAccountInput>().toExtend<
      z.input<typeof createAccountSchema>
    >();
    expectTypeOf<
      z.input<typeof createAccountSchema>
    >().toExtend<CreateAccountInput>();
  });

  it("EntryInput matches entryInputSchema's input", () => {
    expectTypeOf<EntryInput>().toExtend<z.input<typeof entryInputSchema>>();
    expectTypeOf<z.input<typeof entryInputSchema>>().toExtend<EntryInput>();
  });
});
