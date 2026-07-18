/**
 * Number of decimal places of precision supported for monetary amounts.
 *
 * Pluts stores money as integer minor units (e.g. cents). SCALE = 2 covers
 * 2-decimal currencies such as AUD, USD, and NZD. Raising SCALE is the only
 * change required to support higher-precision currencies (e.g. scale 3 for
 * KWD, 8 for crypto); existing stored minor units would need a rescale
 * migration. All amount math flows through {@link Amount}, so the rest of the
 * domain is scale-agnostic.
 */
export const SCALE = 2;

const FACTOR = 10n ** BigInt(SCALE);

/**
 * A fixed-precision monetary amount stored as integer minor units.
 *
 * Amounts are exact integers in storage; rounding to the supported scale only
 * happens at the input boundary ({@link Amount.fromMajor}) using half-up
 * rounding. This keeps posted entries and the trial balance exact.
 *
 * An {@link Amount} is strictly non-negative: it represents a *quantity* of
 * money, not a signed *balance*. Balance arithmetic (which may legitimately be
 * negative) operates on raw `bigint` and is formatted with {@link formatAmount};
 * see {@link computeBalance}. This separation keeps the type's non-negative
 * invariant honest — there is no `neg()`/`fromSigned()` back door.
 */
export class Amount {
  private constructor(readonly minor: bigint) {}

  static fromMinor(minor: bigint): Amount {
    if (minor < 0n)
      throw new RangeError("Amount minor units must be non-negative");
    return new Amount(minor);
  }

  /**
   * Build an Amount from a major-unit value (e.g. dollars).
   * Half-up rounding to the nearest minor unit, via exact bigint arithmetic.
   */
  static fromMajor(value: number | string): Amount {
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new RangeError("Amount must be finite");
      if (value < 0) throw new RangeError("Amount must be non-negative");
      // Stringify preserving significant fractional digits, then parse exactly.
      return Amount.fromString(value.toString());
    }
    return Amount.fromString(value);
  }

  static zero(): Amount {
    return new Amount(0n);
  }

  private static fromString(s: string): Amount {
    const trimmed = s.trim();
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw new RangeError(`Invalid amount string: ${s}`);
    }
    const [wholeStr, fracRaw = ""] = trimmed.split(".");
    const whole = wholeStr ?? "0";
    const frac = fracRaw ?? "";

    let minor: bigint;
    if (frac.length <= SCALE) {
      const fracPadded = (frac + "0".repeat(SCALE)).slice(0, SCALE);
      minor = BigInt(whole) * FACTOR + BigInt(fracPadded || "0");
    } else {
      // Half-up round the excess fractional digits.
      const keep = frac.slice(0, SCALE);
      const nextDigit = frac.slice(SCALE, SCALE + 1);
      const base = BigInt(whole) * FACTOR + BigInt(keep || "0");
      minor = BigInt(nextDigit) >= 5n ? base + 1n : base;
    }
    return new Amount(minor);
  }

  add(other: Amount): Amount {
    return new Amount(this.minor + other.minor);
  }

  sub(other: Amount): Amount {
    const result = this.minor - other.minor;
    if (result < 0n)
      throw new RangeError("Amount subtraction would be negative");
    return new Amount(result);
  }

  /** Multiply by a non-negative integer scalar. */
  mul(scalar: number | bigint): Amount {
    const s = typeof scalar === "number" ? BigInt(scalar) : scalar;
    if (s < 0n) throw new RangeError("Amount scalar must be non-negative");
    return new Amount(this.minor * s);
  }

  /**
   * Split this amount pro-rata by integer weights, with an explicit policy
   * for the leftover minor units. The results ALWAYS sum exactly to this
   * amount — a split arrives pre-balanced instead of drifting by a cent and
   * bouncing off the entry sum check.
   *
   * Each share starts as `floor(total * weight / weightSum)` (exact bigint
   * math — no floats anywhere); the remaining minor units are then handed
   * out one per line according to `remainder`:
   * - `"largest"` (default): to the lines with the largest truncated
   *   fractional share, ties broken by earlier position — the standard
   *   largest-remainder method. $10.00 over [1,1,1] → 3.34, 3.33, 3.33.
   * - `"first"` / `"last"`: to the first / last positive-weight lines.
   *
   * Weights must be non-negative integers with a positive sum; zero-weight
   * lines receive 0.00 and never a remainder unit.
   */
  allocate(
    weights: readonly (number | bigint)[],
    opts: { remainder?: "first" | "last" | "largest" } = {},
  ): Amount[] {
    if (weights.length === 0) {
      throw new RangeError("allocate requires at least one weight");
    }
    // Array.from visits holes (as undefined) where .map would skip them and
    // propagate the hole into the result; the explicit bigint check then
    // rejects them like any other non-integer weight.
    const ws = Array.from(weights, (w) => {
      if (typeof w === "number") {
        if (!Number.isSafeInteger(w) || w < 0) {
          throw new RangeError(
            `allocate weights must be non-negative integers, got ${w}`,
          );
        }
        return BigInt(w);
      }
      if (typeof w !== "bigint" || w < 0n) {
        throw new RangeError(
          `allocate weights must be non-negative integers, got ${String(w)}`,
        );
      }
      return w;
    });
    const weightSum = ws.reduce((acc, w) => acc + w, 0n);
    if (weightSum === 0n) {
      throw new RangeError("allocate weights must sum to a positive value");
    }

    const shares = ws.map((w) => (this.minor * w) / weightSum);
    let leftover = this.minor - shares.reduce((acc, s) => acc + s, 0n);

    // Positive-weight line indices in remainder-distribution order.
    const eligible = ws
      .map((w, i) => ({ w, i }))
      .filter(({ w }) => w > 0n)
      .map(({ i }) => i);
    let order: number[];
    const policy = opts.remainder ?? "largest";
    if (policy === "first") {
      order = eligible;
    } else if (policy === "last") {
      order = [...eligible].reverse();
    } else if (policy === "largest") {
      const remainderOf = (i: number): bigint =>
        (this.minor * (ws[i] as bigint)) % weightSum;
      order = [...eligible].sort((a, b) => {
        const ra = remainderOf(a);
        const rb = remainderOf(b);
        if (ra !== rb) return rb > ra ? 1 : -1;
        return a - b;
      });
    } else {
      // Untyped callers can pass a misspelled policy; treating it as the
      // default would move the leftover cents while still summing correctly.
      throw new RangeError(`Unknown remainder policy "${policy}"`);
    }

    for (const i of order) {
      if (leftover === 0n) break;
      shares[i] = (shares[i] as bigint) + 1n;
      leftover -= 1n;
    }
    return shares.map((s) => new Amount(s));
  }

  eq(other: Amount): boolean {
    return this.minor === other.minor;
  }

  gt(other: Amount): boolean {
    return this.minor > other.minor;
  }

  lt(other: Amount): boolean {
    return this.minor < other.minor;
  }

  gte(other: Amount): boolean {
    return this.minor >= other.minor;
  }

  lte(other: Amount): boolean {
    return this.minor <= other.minor;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  /** Display as a fixed-precision major-unit string, e.g. "10.00". */
  toMajor(): string {
    const whole = this.minor / FACTOR;
    const frac = this.minor % FACTOR;
    return `${whole}.${frac.toString().padStart(SCALE, "0")}`;
  }

  /**
   * Serialize as a major-units decimal string (e.g. "10.00").
   *
   * This makes `JSON.stringify` safe for objects containing an {@link Amount}
   * (a raw `bigint` would otherwise throw a TypeError). It does NOT help
   * Workers RPC: structured clone ignores `toJSON` and rejects class
   * instances, so RPC boundaries must use the DTO mappers (`toEntryDTO`, etc.)
   * instead.
   */
  toJSON(): string {
    return this.toMajor();
  }

  toString(): string {
    return this.toMajor();
  }
}

/**
 * Format a signed balance (raw minor-unit `bigint`, possibly negative) as a
 * fixed-precision major-unit string, e.g. "10.00" or "-3.50". This is the
 * display helper for balance computations, which return `bigint` rather than
 * the strictly-non-negative {@link Amount}.
 */
export function formatAmount(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  const whole = abs / FACTOR;
  const frac = abs % FACTOR;
  return `${sign}${whole}.${frac.toString().padStart(SCALE, "0")}`;
}
