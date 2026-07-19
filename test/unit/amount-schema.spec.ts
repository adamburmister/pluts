import { afterEach, describe, expect, it, vi } from "vitest";
import { Amount } from "../../src/domain/amount";
import { amountSchema } from "../../src/domain/schemas";

/**
 * F-27: `amountSchema.safeParse` must never throw. The union pre-filters most
 * unparseable input, so the guard around `Amount.fromMajor` is a belt on top of
 * braces — these tests keep the belt honest by forcing the throw path and by
 * fuzzing the reachable input space.
 */
describe("amountSchema", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a Zod issue instead of throwing when fromMajor rejects a value", () => {
    vi.spyOn(Amount, "fromMajor").mockImplementation(() => {
      throw new RangeError("Amount must be finite");
    });

    const result = amountSchema.safeParse(1.23);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(
      "Amount must be finite",
    );
  });

  it("does not report a spurious positivity issue when the parse fails", () => {
    vi.spyOn(Amount, "fromMajor").mockImplementation(() => {
      throw new RangeError("boom");
    });

    const result = amountSchema.safeParse("5.00");

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual(["boom"]);
  });

  it("still rejects zero amounts", () => {
    const result = amountSchema.safeParse(0);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(
      "must be greater than zero",
    );
  });

  it("parses the accepted forms to an Amount", () => {
    expect(amountSchema.parse(1.005).minor).toBe(101n);
    expect(amountSchema.parse("10.5").minor).toBe(1050n);
    expect(amountSchema.parse(Amount.fromMinor(7n)).minor).toBe(7n);
  });

  describe("fuzz: safeParse never throws", () => {
    // Deterministic 32-bit LCG — a fixed seed keeps CI reproducible while still
    // sweeping a wide slice of the input space.
    function makeRandom(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
    }

    const EDGE_CASES: unknown[] = [
      0,
      -0,
      1e-7,
      1e21,
      1e308,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_VALUE,
      Number.EPSILON,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      "",
      "0",
      "0.00",
      "00.001",
      `${"9".repeat(40)}.${"9".repeat(40)}`,
      "1e21",
      "-1",
      " 1 ",
      "abc",
      null,
      undefined,
      {},
      [],
      1n,
      Amount.zero(),
      Amount.fromMinor(5n),
    ];

    function generate(random: () => number): unknown {
      const kind = Math.floor(random() * 5);
      switch (kind) {
        case 0:
          // Numbers across the whole magnitude range, both signs.
          return (random() * 2 - 1) * 10 ** Math.floor(random() * 320 - 10);
        case 1:
          return Math.floor(random() * 1e9) - 5e8;
        case 2: {
          const whole = String(Math.floor(random() * 1e12));
          const frac = String(Math.floor(random() * 1e9));
          return random() < 0.5 ? whole : `${whole}.${frac}`;
        }
        case 3:
          return Amount.fromMinor(BigInt(Math.floor(random() * 1e12)));
        default:
          return String.fromCharCode(
            ...Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
              Math.floor(random() * 128),
            ),
          );
      }
    }

    it("returns a result object for every generated input", () => {
      const random = makeRandom(0x5eed);
      const inputs = [
        ...EDGE_CASES,
        ...Array.from({ length: 2000 }, () => generate(random)),
      ];

      for (const input of inputs) {
        let result: ReturnType<typeof amountSchema.safeParse>;
        try {
          result = amountSchema.safeParse(input);
        } catch (e) {
          throw new Error(
            `safeParse threw for input ${String(input)}: ${String(e)}`,
          );
        }
        expect(result).toHaveProperty("success");
        if (result.success) {
          expect(result.data).toBeInstanceOf(Amount);
          expect(result.data.isPositive()).toBe(true);
        } else {
          expect(result.error.issues.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
