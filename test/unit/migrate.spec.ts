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
});
