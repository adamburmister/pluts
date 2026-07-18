import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { getLedgerMeta, migrate } from "../../src/db/schema";
import { RepositoryError } from "../../src/domain/errors";

// Simulate a future build where SCALE has been raised. Unstamped ledgers all
// predate the meta table, which shipped while SCALE was 2 — so a raised-SCALE
// build opening an unstamped ledger that already holds amounts must refuse
// rather than stamp the new scale over integers written at scale 2.
vi.mock("../../src/domain/amount", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/domain/amount")>()),
  SCALE: 3,
}));

function fakeSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec: (query: string, ...binds: Array<string | number | null>) => {
      const rows = db.prepare(query).all(...binds);
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
}

// The real v1 DDL, minus the meta machinery migrate would add — a database as
// the pre-meta release left it.
function provisionLegacyLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE pluts_accounts (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    contra INTEGER DEFAULT 0 NOT NULL, created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE pluts_entries (
    id TEXT PRIMARY KEY NOT NULL, description TEXT NOT NULL,
    date TEXT NOT NULL, posted_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE pluts_amounts (
    id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL,
    account_id TEXT NOT NULL, entry_id TEXT NOT NULL, amount INTEGER NOT NULL
  )`);
}

describe("unstamped ledgers under a raised SCALE (mocked SCALE = 3)", () => {
  it("refuses to stamp a non-empty unstamped ledger", () => {
    const db = new DatabaseSync(":memory:");
    provisionLegacyLedger(db);
    db.prepare(
      "INSERT INTO pluts_accounts (id, name, type, contra, created_at) VALUES ('a1', 'Cash', 'Asset', 0, 't')",
    ).run();
    db.prepare(
      "INSERT INTO pluts_entries (id, description, date, posted_at) VALUES ('e1', 'Sale', '2026-01-05', 't')",
    ).run();
    db.prepare(
      "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('m1', 'debit', 'a1', 'e1', 100)",
    ).run();

    expect(() => migrate(fakeSqlStorage(db))).toThrow(RepositoryError);
    // Nothing stamped: a later scale-2 build (or an explicit rescale
    // migration) can still open it correctly.
    const scaleRow = db
      .prepare("SELECT value FROM pluts_ledger_meta WHERE key = 'scale'")
      .get();
    expect(scaleRow).toBeUndefined();
  });

  it("stamps an empty unstamped ledger at the new scale", () => {
    const db = new DatabaseSync(":memory:");
    provisionLegacyLedger(db);
    migrate(fakeSqlStorage(db));
    expect(getLedgerMeta(fakeSqlStorage(db)).scale).toBe(3);
  });
});
