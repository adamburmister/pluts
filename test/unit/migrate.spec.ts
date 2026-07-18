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
    exec: (query: string) => {
      const rows = db.prepare(query).all();
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

  it("adds payload_hash to a database provisioned before fingerprints", () => {
    const db = new DatabaseSync(":memory:");
    // Simulate a legacy database: entries + entry_keys without payload_hash.
    db.exec(`CREATE TABLE pluts_entries (
      id TEXT PRIMARY KEY NOT NULL,
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      posted_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE pluts_entry_keys (
      key TEXT PRIMARY KEY NOT NULL,
      entry_id TEXT NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES pluts_entries(id)
    )`);
    db.exec(
      "INSERT INTO pluts_entries (id, description, date, posted_at) VALUES ('ent-1', 'Sale', '2026-01-05', '2026-01-05T10:00:00Z')",
    );
    db.exec(
      "INSERT INTO pluts_entry_keys (key, entry_id) VALUES ('old-key', 'ent-1')",
    );

    migrate(fakeSqlStorage(db));

    const cols = db
      .prepare("PRAGMA table_info(pluts_entry_keys)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("payload_hash");
    // Legacy rows carry the '' default: "no recorded fingerprint".
    const row = db
      .prepare(
        "SELECT payload_hash FROM pluts_entry_keys WHERE key = 'old-key'",
      )
      .get();
    expect(row?.payload_hash).toBe("");
  });

  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    expect(() => migrate(fakeSqlStorage(db))).not.toThrow();
    db.close();
  });
});
