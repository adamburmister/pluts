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
        `${"1" + "0".repeat(21)}.00`,
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
