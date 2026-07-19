import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";

/**
 * A minimal SqlStorage stand-in over node:sqlite, sufficient for migrate():
 * exec(sql) returning a cursor whose toArray() yields the rows. StatementSync
 * .all() executes non-reader statements too (returning []), so DDL, ALTER,
 * and PRAGMA all flow through the same path.
 */
function fakeSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec: (query: string, ...binds: Array<string | number | null>) => {
      const rows = db.prepare(query).all(...binds);
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
}

describe("migrate", () => {
  it("provisions a fresh database with the payload_hash column", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    const cols = db
      .prepare("PRAGMA table_info(pluts_entry_keys)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("payload_hash");
    db.close();
  });

  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    expect(() => migrate(fakeSqlStorage(db))).not.toThrow();
    db.close();
  });

  // Schema v1 had no guards on pluts_accounts, so a v1 ledger can already
  // hold an account parked at a negative rowid. The v2 replace guard reads
  // NEW.rowid = -1 as "auto-assigned", so such a row would make the sentinel
  // match a real row and abort EVERY subsequent account insert. The upgrade
  // has to relocate the legacy rows before the guard goes live.
  it("relocates legacy negative account rowids on upgrade from v1", () => {
    const db = new DatabaseSync(":memory:");
    // A v1-shaped database: the accounts table without the v2 triggers.
    db.exec(`CREATE TABLE pluts_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      contra INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec(
      "INSERT INTO pluts_accounts (rowid, id, name, type, contra, created_at) VALUES (-3, 'acc-a', 'Cash', 'Asset', 0, '2026-01-01T00:00:00Z')",
    );
    db.exec(
      "INSERT INTO pluts_accounts (rowid, id, name, type, contra, created_at) VALUES (-1, 'acc-b', 'Revenue', 'Revenue', 0, '2026-01-01T00:00:00Z')",
    );

    migrate(fakeSqlStorage(db));

    const negatives = db
      .prepare("SELECT COUNT(*) AS n FROM pluts_accounts WHERE rowid < 0")
      .get();
    expect(negatives?.n).toBe(0);
    // Relocation must preserve the accounts themselves, not drop them.
    const ids = db
      .prepare("SELECT id FROM pluts_accounts ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(ids).toEqual(["acc-a", "acc-b"]);

    // The point of the repair: ordinary account creation still works.
    expect(() =>
      db
        .prepare(
          "INSERT INTO pluts_accounts (id, name, type, contra, created_at) VALUES ('acc-c', 'Rent', 'Expense', 0, '2026-01-02T00:00:00Z')",
        )
        .run(),
    ).not.toThrow();
    db.close();
  });
});
