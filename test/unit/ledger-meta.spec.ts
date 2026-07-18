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

describe("migration safety", () => {
  // A DO rolled back to an older build must not run against a schema stamped
  // by a newer release — the older code has no idea what changed.
  it("refuses to open a database stamped with a newer schema version", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    db.prepare(
      "UPDATE pluts_ledger_meta SET value = ? WHERE key = 'schema_version'",
    ).run(String(SCHEMA_VERSION + 1));
    expect(() => migrate(fakeSqlStorage(db))).toThrow(RepositoryError);
  });

  // The refusal must happen BEFORE any other DDL runs: a newer release may
  // have reshaped tables this build's statements still reference, so an old
  // build must not execute v1 DDL against a v2 database on its way to the
  // version check.
  it("rejects a newer schema version before applying any other DDL", () => {
    const db = new DatabaseSync(":memory:");
    // A database as a newer release would leave it: meta stamped, and the
    // rest of the schema owned by that newer version (not created here).
    db.exec(
      "CREATE TABLE pluts_ledger_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO pluts_ledger_meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION + 1));

    expect(() => migrate(fakeSqlStorage(db))).toThrow(RepositoryError);
    // No v1 DDL may have executed before the refusal.
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'pluts_ledger_meta'",
      )
      .all();
    expect(tables).toEqual([]);
  });

  it("advances an older stored schema version to the current one", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    db.prepare(
      "UPDATE pluts_ledger_meta SET value = '0' WHERE key = 'schema_version'",
    ).run();
    migrate(fakeSqlStorage(db));
    expect(getLedgerMeta(fakeSqlStorage(db)).schemaVersion).toBe(
      SCHEMA_VERSION,
    );
  });

  // A whitespace-only configured currency must not permanently stamp "" —
  // that blank row is falsy in the mismatch check, so a later real currency
  // would silently coexist with an unenforceable blank denomination.
  it("treats a whitespace-only currency as absent", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db), { currency: "   " });
    expect(getLedgerMeta(fakeSqlStorage(db)).currency).toBeUndefined();
    migrate(fakeSqlStorage(db), { currency: "USD" });
    expect(getLedgerMeta(fakeSqlStorage(db)).currency).toBe("USD");
  });
});
