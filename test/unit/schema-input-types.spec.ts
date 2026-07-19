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
// `toEqualTypeOf` is avoided on purpose: zod's `ZodDefault` brands its input
// type (e.g. `contra` on `createAccountSchema`) in a way that trips the
// matcher's structural-identity check even when the resolved shape is
// identical. Each interface is instead pinned by two exact checks, which
// between them leave no gap:
//   1. `keyof` equality — catches an added or removed field, *including an
//      optional one* (bidirectional assignability alone would miss that: a type
//      without an optional field still extends one that has it, and vice versa).
//   2. bidirectional assignability — catches any field whose type or `?`
//      optionality changed while the key set stayed the same.
type AmountInputSchema = z.input<typeof amountLineSchema>;
type CreateAccountInputSchema = z.input<typeof createAccountSchema>;
type EntryInputSchema = z.input<typeof entryInputSchema>;

describe("public input interfaces stay in sync with their zod schemas", () => {
  it("AmountInput matches amountLineSchema's input", () => {
    expectTypeOf<keyof AmountInput>().toEqualTypeOf<keyof AmountInputSchema>();
    expectTypeOf<AmountInput>().toExtend<AmountInputSchema>();
    expectTypeOf<AmountInputSchema>().toExtend<AmountInput>();
  });

  it("CreateAccountInput matches createAccountSchema's input", () => {
    expectTypeOf<keyof CreateAccountInput>().toEqualTypeOf<
      keyof CreateAccountInputSchema
    >();
    expectTypeOf<CreateAccountInput>().toExtend<CreateAccountInputSchema>();
    expectTypeOf<CreateAccountInputSchema>().toExtend<CreateAccountInput>();
  });

  it("EntryInput matches entryInputSchema's input", () => {
    expectTypeOf<keyof EntryInput>().toEqualTypeOf<keyof EntryInputSchema>();
    expectTypeOf<EntryInput>().toExtend<EntryInputSchema>();
    expectTypeOf<EntryInputSchema>().toExtend<EntryInput>();
  });
});
