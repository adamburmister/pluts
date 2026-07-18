import { describe, expect, it } from "vitest";
import { Amount, formatAmount, SCALE } from "../../src/domain/amount";

describe("Amount", () => {
  it("exposes a 2-decimal scale", () => {
    expect(SCALE).toBe(2);
  });

  describe("fromMajor", () => {
    it("parses whole numbers", () => {
      expect(Amount.fromMajor(10).toJSON()).toBe("10.00");
    });

    it("parses decimals", () => {
      expect(Amount.fromMajor("10.50").toJSON()).toBe("10.50");
    });

    it("pads fractional digits to the scale", () => {
      expect(Amount.fromMajor("10.5").toJSON()).toBe("10.50");
      expect(Amount.fromMajor("10").toJSON()).toBe("10.00");
    });

    it("rounds half-up to the nearest minor unit", () => {
      expect(Amount.fromMajor(0.005).toJSON()).toBe("0.01");
      expect(Amount.fromMajor(0.004).toJSON()).toBe("0.00");
      expect(Amount.fromMajor(1.235).toJSON()).toBe("1.24");
    });

    // F-12: Number.prototype.toString switches to scientific notation for
    // |exp| >= 21 or <= -7; the digit regex rejected those, so an innocent
    // tiny/huge number crashed with a raw RangeError instead of parsing.
    it("parses numbers that stringify in scientific notation", () => {
      expect(Amount.fromMajor(1e-7).toMajor()).toBe("0.00");
      expect(Amount.fromMajor(5e-3).toMajor()).toBe("0.01");
      expect(Amount.fromMajor(1.5e3).toMajor()).toBe("1500.00");
      expect(Amount.fromMajor(1e21).toMajor()).toBe(
        `${`1${"0".repeat(21)}`}.00`,
      );
    });

    it("rejects negative and non-finite values", () => {
      expect(() => Amount.fromMajor(-1)).toThrow();
      expect(() => Amount.fromMajor(Number.NaN)).toThrow();
      expect(() => Amount.fromMajor(Number.POSITIVE_INFINITY)).toThrow();
    });

    it("rejects malformed strings", () => {
      expect(() => Amount.fromMajor("abc")).toThrow();
      expect(() => Amount.fromMajor("-5.00")).toThrow();
    });
  });

  describe("fromMinor / zero", () => {
    it("builds from bigint minor units", () => {
      expect(Amount.fromMinor(500n).toJSON()).toBe("5.00");
    });
    it("zero is zero", () => {
      expect(Amount.zero().isZero()).toBe(true);
    });
  });

  describe("arithmetic", () => {
    it("adds", () => {
      expect(Amount.fromMajor(1).add(Amount.fromMajor("2.50")).toJSON()).toBe(
        "3.50",
      );
    });
    it("subtracts (non-negative only)", () => {
      expect(Amount.fromMajor(5).sub(Amount.fromMajor(2)).toJSON()).toBe(
        "3.00",
      );
      expect(() => Amount.fromMajor(2).sub(Amount.fromMajor(5))).toThrow();
    });
    it("multiplies by a scalar", () => {
      expect(Amount.fromMajor("1.50").mul(3).toJSON()).toBe("4.50");
      expect(() => Amount.fromMajor(1).mul(-1)).toThrow();
    });
    it("is strictly non-negative (no neg/fromSigned back door)", () => {
      expect(() => Amount.fromMinor(-1n)).toThrow();
    });
  });

  describe("comparisons", () => {
    it("compares equality and ordering", () => {
      const a = Amount.fromMajor(5);
      const b = Amount.fromMajor("5.00");
      const c = Amount.fromMajor(3);
      expect(a.eq(b)).toBe(true);
      expect(a.gt(c)).toBe(true);
      expect(c.lt(a)).toBe(true);
      expect(a.gte(b)).toBe(true);
      expect(c.lte(a)).toBe(true);
    });
    it("isPositive / isZero", () => {
      expect(Amount.fromMajor(1).isPositive()).toBe(true);
      expect(Amount.zero().isZero()).toBe(true);
    });
  });

  /**
   * F-15: pro-rata splits were the one money operation callers had to
   * hand-roll (usually in floats). allocate() answers "where do the
   * remainder cents go?" explicitly: exact bigint math, results always sum
   * to the original, leftover minor units distributed per policy.
   */
  describe("allocate", () => {
    const majors = (amounts: Amount[]) => amounts.map((a) => a.toMajor());

    it("splits $10.00 three ways with the extra cent on the first line (largest-remainder default)", () => {
      expect(majors(Amount.fromMajor("10.00").allocate([1, 1, 1]))).toEqual([
        "3.34",
        "3.33",
        "3.33",
      ]);
    });

    it("always sums exactly to the original", () => {
      const cases: [string, Array<number | bigint>][] = [
        ["10.00", [1, 1, 1]],
        ["99.99", [50, 30, 20]],
        ["0.05", [3, 7]],
        ["1.01", [2, 1]],
        ["123456.78", [7, 11, 13, 17]],
      ];
      for (const [total, weights] of cases) {
        const original = Amount.fromMajor(total);
        const parts = original.allocate(weights);
        const sum = parts.reduce((acc, p) => acc.add(p), Amount.zero());
        expect(sum.eq(original)).toBe(true);
      }
    });

    it("gives remainder cents to the largest fractional shares first", () => {
      // 101 minor over [2, 1]: floors are 67 and 33 (remainders 1/3 and 2/3);
      // the leftover cent goes to the larger remainder — the second line.
      expect(majors(Amount.fromMajor("1.01").allocate([2, 1]))).toEqual([
        "0.67",
        "0.34",
      ]);
    });

    it("supports first and last remainder policies", () => {
      expect(
        majors(
          Amount.fromMajor("10.00").allocate([1, 1, 1], { remainder: "last" }),
        ),
      ).toEqual(["3.33", "3.33", "3.34"]);
      expect(
        majors(
          Amount.fromMajor("10.00").allocate([1, 1, 1], { remainder: "first" }),
        ),
      ).toEqual(["3.34", "3.33", "3.33"]);
    });

    it("never assigns remainder cents to zero-weight lines", () => {
      expect(
        majors(
          Amount.fromMajor("0.01").allocate([0, 1], { remainder: "first" }),
        ),
      ).toEqual(["0.00", "0.01"]);
    });

    it("rejects invalid weights", () => {
      const ten = Amount.fromMajor("10.00");
      expect(() => ten.allocate([])).toThrow(RangeError);
      expect(() => ten.allocate([0, 0])).toThrow(RangeError);
      expect(() => ten.allocate([1, -1])).toThrow(RangeError);
      expect(() => ten.allocate([1.5, 1])).toThrow(RangeError);
    });

    // A misspelled policy from untyped JS must fail fast, not silently run
    // Array.prototype.map skips holes, so a sparse weights array would sail
    // through per-weight validation and return an array with holes instead
    // of Amounts — breaking callers that zip the parts back onto lines.
    it("rejects sparse and undefined weights", () => {
      const ten = Amount.fromMajor("10.00");
      // biome-ignore lint/suspicious/noSparseArray: the sparse array IS the case under test
      expect(() => ten.allocate([1, , 1] as unknown as number[])).toThrow(
        RangeError,
      );
      expect(() =>
        ten.allocate([1, undefined, 1] as unknown as number[]),
      ).toThrow(RangeError);
    });

    // as "largest" — that could hand the leftover cents to different lines
    // than intended while still returning a balanced-looking split.
    it("rejects unknown remainder policies", () => {
      const ten = Amount.fromMajor("10.00");
      expect(() =>
        ten.allocate([1, 1, 1], {
          remainder: "frist" as unknown as "first",
        }),
      ).toThrow(RangeError);
    });
  });

  describe("display", () => {
    it("formats non-negative amounts", () => {
      expect(Amount.fromMinor(1050n).toMajor()).toBe("10.50");
      expect(Amount.fromMinor(5n).toMajor()).toBe("0.05");
      expect(Amount.fromMinor(0n).toMajor()).toBe("0.00");
    });
    it("formatAmount handles signed balances", () => {
      expect(formatAmount(0n)).toBe("0.00");
      expect(formatAmount(-1050n)).toBe("-10.50");
      expect(formatAmount(5n)).toBe("0.05");
    });
  });
});
