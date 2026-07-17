import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { getLedgerMeta, migrate, SCHEMA_VERSION } from "../../src/db/schema";
import { SCALE } from "../../src/domain/amount";
import { RepositoryError } from "../../src/domain/errors";

/**
 * F-07 / F-10: the database must be self-describing. Its integers are
 * meaningless without knowing the scale (and ideally currency) they
 * denominate, and schema evolution needs a recorded version — the previous
 * migration story for incompatible changes was "delete the database", which
 * is not a migration story for financial records.
 */
function fakeSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec: (query: string, ...binds: Array<string | number | null>) => {
      const rows = db.prepare(query).all(...binds);
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
}

describe("ledger metadata", () => {
  it("stamps scale and schema_version on a fresh database", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    const meta = getLedgerMeta(fakeSqlStorage(db));
    expect(meta.scale).toBe(SCALE);
    expect(meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(meta.currency).toBeUndefined();
  });

  it("records the ledger currency when provided", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db), { currency: "NZD" });
    expect(getLedgerMeta(fakeSqlStorage(db)).currency).toBe("NZD");
    // Re-running with the same currency is a no-op.
    expect(() =>
      migrate(fakeSqlStorage(db), { currency: "NZD" }),
    ).not.toThrow();
  });

  it("stamps currency onto an existing un-stamped ledger", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    migrate(fakeSqlStorage(db), { currency: "USD" });
    expect(getLedgerMeta(fakeSqlStorage(db)).currency).toBe("USD");
  });

  it("refuses to open a ledger with a different currency", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db), { currency: "USD" });
    expect(() => migrate(fakeSqlStorage(db), { currency: "EUR" })).toThrow(
      RepositoryError,
    );
  });

  it("refuses to open a ledger written at a different scale", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    // Simulate a ledger whose stored minor units were written at scale 3.
    db.prepare(
      "UPDATE pluts_ledger_meta SET value = '3' WHERE key = 'scale'",
    ).run();
    expect(() => migrate(fakeSqlStorage(db))).toThrow(RepositoryError);
  });

  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db), { currency: "AUD" });
    expect(() =>
      migrate(fakeSqlStorage(db), { currency: "AUD" }),
    ).not.toThrow();
    expect(() => migrate(fakeSqlStorage(db))).not.toThrow();
    expect(getLedgerMeta(fakeSqlStorage(db)).currency).toBe("AUD");
  });
});
