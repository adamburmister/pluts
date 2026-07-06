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
 */
export class Amount {
  private constructor(readonly minor: bigint) {}

  static fromMinor(minor: bigint): Amount {
    if (minor < 0n) throw new RangeError('Amount minor units must be non-negative');
    return new Amount(minor);
  }

  /**
   * Build an Amount from a major-unit value (e.g. dollars).
   * Half-up rounding to the nearest minor unit, via exact bigint arithmetic.
   */
  static fromMajor(value: number | string): Amount {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError('Amount must be finite');
      if (value < 0) throw new RangeError('Amount must be non-negative');
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
    const [wholeStr, fracRaw = ''] = trimmed.split('.');
    const whole = wholeStr ?? '0';
    const frac = fracRaw ?? '';

    let minor: bigint;
    if (frac.length <= SCALE) {
      const fracPadded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
      minor = BigInt(whole) * FACTOR + BigInt(fracPadded || '0');
    } else {
      // Half-up round the excess fractional digits.
      const keep = frac.slice(0, SCALE);
      const nextDigit = frac.slice(SCALE, SCALE + 1);
      const base = BigInt(whole) * FACTOR + BigInt(keep || '0');
      minor = BigInt(nextDigit) >= 5n ? base + 1n : base;
    }
    return new Amount(minor);
  }

  add(other: Amount): Amount {
    return new Amount(this.minor + other.minor);
  }

  sub(other: Amount): Amount {
    const result = this.minor - other.minor;
    if (result < 0n) throw new RangeError('Amount subtraction would be negative');
    return new Amount(result);
  }

  /** Multiply by a non-negative integer scalar. */
  mul(scalar: number | bigint): Amount {
    const s = typeof scalar === 'number' ? BigInt(scalar) : scalar;
    if (s < 0n) throw new RangeError('Amount scalar must be non-negative');
    return new Amount(this.minor * s);
  }

  neg(): Amount {
    return new Amount(-this.minor);
  }

  /** Return this amount's minor units as a signed bigint (for balance math). */
  signed(): bigint {
    return this.minor;
  }

  /** Build an Amount from a possibly-negative signed bigint (internal balance use). */
  static fromSigned(signed: bigint): Amount {
    return new Amount(signed);
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
    const sign = this.minor < 0n ? '-' : '';
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const whole = abs / FACTOR;
    const frac = abs % FACTOR;
    return `${sign}${whole}.${frac.toString().padStart(SCALE, '0')}`;
  }

  toJSON(): string {
    return this.minor.toString();
  }

  toString(): string {
    return this.toMajor();
  }
}
