import { describe, expect, it } from "vitest";
import {
  fromStorageInt,
  toStorageInt,
} from "../../src/db/sqlite-storage-repository";
import { RepositoryError } from "../../src/domain/errors";

/**
 * F-06: SqlStorage cannot bind bigint, so amounts cross an IEEE 754 `number`
 * boundary on every write and read (including SUM aggregates). Number() and
 * BigInt() do not error on precision loss — above 2^53 they silently corrupt
 * the value. The bridge must fail loudly instead.
 */
describe("toStorageInt (write path)", () => {
  it("passes exact values through", () => {
    expect(toStorageInt(0n)).toBe(0);
    expect(toStorageInt(123_456n)).toBe(123456);
    expect(toStorageInt(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("throws RepositoryError instead of silently losing precision", () => {
    expect(() => toStorageInt(2n ** 53n)).toThrow(RepositoryError);
    expect(() => toStorageInt(2n ** 53n + 1n)).toThrow(RepositoryError);
  });
});

describe("fromStorageInt (read path)", () => {
  it("converts safe integers", () => {
    expect(fromStorageInt(0, "test")).toBe(0n);
    expect(fromStorageInt(123456, "test")).toBe(123456n);
    expect(fromStorageInt(Number.MAX_SAFE_INTEGER, "test")).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it("throws RepositoryError on unsafe integers (silent SUM overflow)", () => {
    expect(() => fromStorageInt(2 ** 53, "test")).toThrow(RepositoryError);
  });

  it("throws RepositoryError on non-integer values (float contamination)", () => {
    expect(() => fromStorageInt(10.5, "test")).toThrow(RepositoryError);
    expect(() => fromStorageInt(Number.NaN, "test")).toThrow(RepositoryError);
  });
});
