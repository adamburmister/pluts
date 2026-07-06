import { describe, expect, it } from 'vitest';
import { Amount, SCALE } from '../../src/domain/amount.js';

describe('Amount', () => {
  it('exposes a 2-decimal scale', () => {
    expect(SCALE).toBe(2);
  });

  describe('fromMajor', () => {
    it('parses whole numbers', () => {
      expect(Amount.fromMajor(10).toJSON()).toBe('1000');
    });

    it('parses decimals', () => {
      expect(Amount.fromMajor('10.50').toJSON()).toBe('1050');
    });

    it('pads fractional digits to the scale', () => {
      expect(Amount.fromMajor('10.5').toJSON()).toBe('1050');
      expect(Amount.fromMajor('10').toJSON()).toBe('1000');
    });

    it('rounds half-up to the nearest minor unit', () => {
      expect(Amount.fromMajor(0.005).toJSON()).toBe('1');
      expect(Amount.fromMajor(0.004).toJSON()).toBe('0');
      expect(Amount.fromMajor(1.235).toJSON()).toBe('124');
    });

    it('rejects negative and non-finite values', () => {
      expect(() => Amount.fromMajor(-1)).toThrow();
      expect(() => Amount.fromMajor(Number.NaN)).toThrow();
      expect(() => Amount.fromMajor(Number.POSITIVE_INFINITY)).toThrow();
    });

    it('rejects malformed strings', () => {
      expect(() => Amount.fromMajor('abc')).toThrow();
      expect(() => Amount.fromMajor('-5.00')).toThrow();
    });
  });

  describe('fromMinor / zero', () => {
    it('builds from bigint minor units', () => {
      expect(Amount.fromMinor(500n).toJSON()).toBe('500');
    });
    it('zero is zero', () => {
      expect(Amount.zero().isZero()).toBe(true);
    });
  });

  describe('arithmetic', () => {
    it('adds', () => {
      expect(Amount.fromMajor(1).add(Amount.fromMajor('2.50')).toJSON()).toBe('350');
    });
    it('subtracts (non-negative only)', () => {
      expect(Amount.fromMajor(5).sub(Amount.fromMajor(2)).toJSON()).toBe('300');
      expect(() => Amount.fromMajor(2).sub(Amount.fromMajor(5))).toThrow();
    });
    it('multiplies by a scalar', () => {
      expect(Amount.fromMajor('1.50').mul(3).toJSON()).toBe('450');
      expect(() => Amount.fromMajor(1).mul(-1)).toThrow();
    });
    it('negates for balance math', () => {
      expect(Amount.fromMajor(5).neg().signed()).toBe(-500n);
    });
  });

  describe('comparisons', () => {
    it('compares equality and ordering', () => {
      const a = Amount.fromMajor(5);
      const b = Amount.fromMajor('5.00');
      const c = Amount.fromMajor(3);
      expect(a.eq(b)).toBe(true);
      expect(a.gt(c)).toBe(true);
      expect(c.lt(a)).toBe(true);
      expect(a.gte(b)).toBe(true);
      expect(c.lte(a)).toBe(true);
    });
    it('isPositive / isZero', () => {
      expect(Amount.fromMajor(1).isPositive()).toBe(true);
      expect(Amount.zero().isZero()).toBe(true);
    });
  });

  describe('display', () => {
    it('formats to fixed-precision major string', () => {
      expect(Amount.fromMinor(1050n).toMajor()).toBe('10.50');
      expect(Amount.fromMinor(5n).toMajor()).toBe('0.05');
      expect(Amount.fromMinor(0n).toMajor()).toBe('0.00');
    });
    it('handles negative display', () => {
      expect(Amount.fromSigned(-1050n).toMajor()).toBe('-10.50');
    });
  });
});
