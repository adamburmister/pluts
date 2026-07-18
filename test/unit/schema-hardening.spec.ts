import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_STATEMENTS } from "../../src/db/schema";

/**
 * F-04 / F-14: the ledger tables must be self-defending. Posted entries are
 * append-only — a stray UPDATE or DELETE from consumer code (which holds the
 * raw SqlStorage handle by design) must abort, and malformed rows written by
 * non-library SQL must be rejected at the schema level.
 *
 * These tests run the real DDL against SQLite via node:sqlite — the same
 * engine family as Durable Object storage.
 */
describe("schema hardening", () => {
  let db: DatabaseSync;

  function applySchema() {
    for (const stmt of SCHEMA_STATEMENTS) {
      db.exec(stmt);
    }
  }

  function seed() {
    db.prepare(
      "INSERT INTO pluts_accounts (id, name, type, contra, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run("acc-1", "Cash", "Asset", "2026-01-01T00:00:00Z");
    db.prepare(
      "INSERT INTO pluts_accounts (id, name, type, contra, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run("acc-2", "Revenue", "Revenue", "2026-01-01T00:00:00Z");
    db.prepare(
      "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES (?, ?, ?, ?, ?)",
    ).run("ent-1", "Sale", "2026-01-05", "2026-01-05T10:00:00Z", 1);
    db.prepare(
      "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES (?, ?, ?, ?, ?)",
    ).run("amt-1", "debit", "acc-1", "ent-1", 10000);
    db.prepare(
      "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES (?, ?, ?, ?, ?)",
    ).run("amt-2", "credit", "acc-2", "ent-1", 10000);
    db.prepare(
      "INSERT INTO pluts_entry_keys (key, entry_id, payload_hash) VALUES (?, ?, ?)",
    ).run("key-1", "ent-1", "a".repeat(64));
  }

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applySchema();
    seed();
  });

  afterEach(() => {
    db.close();
  });

  it("is idempotent: applying the schema twice succeeds", () => {
    expect(() => applySchema()).not.toThrow();
  });

  describe("append-only enforcement (F-04)", () => {
    it("blocks UPDATE of a posted entry", () => {
      expect(() =>
        db.prepare("UPDATE pluts_entries SET date = '2025-12-31'").run(),
      ).toThrow(/append-only/);
      expect(() =>
        db.prepare("UPDATE pluts_entries SET description = 'rewritten'").run(),
      ).toThrow(/append-only/);
    });

    it("blocks DELETE of a posted entry", () => {
      expect(() => db.prepare("DELETE FROM pluts_entries").run()).toThrow(
        /append-only/,
      );
    });

    it("blocks UPDATE of a posted amount", () => {
      expect(() =>
        db.prepare("UPDATE pluts_amounts SET amount = 1").run(),
      ).toThrow(/append-only/);
    });

    it("blocks DELETE of a posted amount", () => {
      expect(() => db.prepare("DELETE FROM pluts_amounts").run()).toThrow(
        /append-only/,
      );
    });

    it("blocks UPDATE and DELETE of idempotency keys", () => {
      expect(() =>
        db.prepare("UPDATE pluts_entry_keys SET entry_id = 'x'").run(),
      ).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM pluts_entry_keys").run()).toThrow(
        /append-only/,
      );
    });

    // With SQLite's default recursive_triggers = OFF, INSERT OR REPLACE
    // resolves a PK conflict by deleting the existing row WITHOUT firing the
    // DELETE trigger — a silent rewrite path around append-only. BEFORE
    // INSERT guards fire before conflict resolution and close it.
    it("blocks INSERT OR REPLACE from rewriting a posted amount", () => {
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-1', 'debit', 'acc-1', 'ent-1', 1)",
          )
          .run(),
      ).toThrow(/append-only/);
      const row = db
        .prepare("SELECT amount FROM pluts_amounts WHERE id = 'amt-1'")
        .get();
      expect(row?.amount).toBe(10000);
    });

    it("blocks INSERT OR REPLACE from rewriting a posted entry", () => {
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO pluts_entries (id, description, date, posted_at) VALUES ('ent-1', 'rewritten', '2026-01-05', '2026-01-05T10:00:00Z')",
          )
          .run(),
      ).toThrow(/append-only/);
      const row = db
        .prepare("SELECT description FROM pluts_entries WHERE id = 'ent-1'")
        .get();
      expect(row?.description).toBe("Sale");
    });

    it("blocks INSERT OR REPLACE from remapping an idempotency key", () => {
      db.prepare(
        "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES ('ent-2', 'Other', '2026-01-06', '2026-01-06T10:00:00Z', 2)",
      ).run();
      // The guard's message must still read as a unique-constraint failure:
      // the repository's concurrent-post recovery path string-matches
      // "UNIQUE constraint failed" on duplicate key inserts.
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO pluts_entry_keys (key, entry_id) VALUES ('key-1', 'ent-2')",
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entry_keys (key, entry_id) VALUES ('key-1', 'ent-2')",
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/);
      const row = db
        .prepare("SELECT entry_id FROM pluts_entry_keys WHERE key = 'key-1'")
        .get();
      expect(row?.entry_id).toBe("ent-1");
    });

    // These are rowid tables, so REPLACE can also conflict on rowid: a raw
    // insert reusing an existing row's rowid with a DIFFERENT id slips past
    // an id-only guard, and the conflict delete bypasses the DELETE trigger
    // (recursive_triggers is OFF by default). The guards must abort on rowid
    // conflicts too.
    it("blocks INSERT OR REPLACE via rowid from rewriting a posted amount", () => {
      const rowid = db
        .prepare("SELECT rowid FROM pluts_amounts WHERE id = 'amt-1'")
        .get()?.rowid as number;
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO pluts_amounts (rowid, id, type, account_id, entry_id, amount) VALUES (?, 'amt-evil', 'debit', 'acc-1', 'ent-1', 1)",
          )
          .run(rowid),
      ).toThrow(/append-only/);
      const row = db
        .prepare("SELECT amount FROM pluts_amounts WHERE id = 'amt-1'")
        .get();
      expect(row?.amount).toBe(10000);
    });

    it("blocks INSERT OR REPLACE via rowid from rewriting a posted entry", () => {
      const rowid = db
        .prepare("SELECT rowid FROM pluts_entries WHERE id = 'ent-1'")
        .get()?.rowid as number;
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO pluts_entries (rowid, id, description, date, posted_at) VALUES (?, 'ent-evil', 'rewritten', '2026-01-05', '2026-01-05T10:00:00Z')",
          )
          .run(rowid),
      ).toThrow(/append-only/);
      const row = db
        .prepare("SELECT description FROM pluts_entries WHERE id = 'ent-1'")
        .get();
      expect(row?.description).toBe("Sale");
    });

    it("blocks INSERT OR REPLACE via rowid from remapping an idempotency key", () => {
      db.prepare(
        "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES ('ent-2', 'Other', '2026-01-06', '2026-01-06T10:00:00Z', 2)",
      ).run();
      const rowid = db
        .prepare("SELECT rowid FROM pluts_entry_keys WHERE key = 'key-1'")
        .get()?.rowid as number;
      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO pluts_entry_keys (rowid, key, entry_id) VALUES (?, 'key-evil', 'ent-2')",
          )
          .run(rowid),
      ).toThrow();
      const row = db
        .prepare("SELECT entry_id FROM pluts_entry_keys WHERE key = 'key-1'")
        .get();
      expect(row?.entry_id).toBe("ent-1");
    });
  });

  describe("row validity enforcement (F-14)", () => {
    it("rejects an amount with an invalid kind", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-x', 'Debit', 'acc-1', 'ent-1', 100)",
          )
          .run(),
      ).toThrow();
    });

    it("rejects a negative amount", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-x', 'debit', 'acc-1', 'ent-1', -100)",
          )
          .run(),
      ).toThrow();
    });

    it("rejects a non-integer (float) amount", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-x', 'debit', 'acc-1', 'ent-1', 10.5)",
          )
          .run(),
      ).toThrow();
    });

    it("rejects an entry with a malformed date", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES ('ent-x', 'bad', 'not-a-date', '2026-01-05T10:00:00Z', 2)",
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES ('ent-y', 'bad', '2026-1-5', '2026-01-05T10:00:00Z', 2)",
          )
          .run(),
      ).toThrow();
    });

    // The yyyy-mm-dd GLOB alone admits impossible dates like 2026-02-30;
    // lexicographic range filters would then silently mis-bucket those rows.
    it("rejects an entry with an impossible calendar date", () => {
      for (const bad of ["2026-13-01", "2026-02-30", "2026-00-10"]) {
        expect(() =>
          db
            .prepare(
              "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES (?, 'bad', ?, '2026-01-05T10:00:00Z', 2)",
            )
            .run(`ent-${bad}`, bad),
        ).toThrow();
      }
    });

    // The entries UPDATE trigger is column-scoped (so future migration
    // columns stay backfillable), which left rowid assignments unguarded:
    // UPDATE ... SET rowid = -1 bypassed every trigger, and the poisoned
    // sentinel then bricked all ordinary inserts. Amounts and entry_keys
    // use bare UPDATE triggers and were already covered.
    it("blocks rowid-only UPDATEs on entries", () => {
      expect(() =>
        db
          .prepare("UPDATE pluts_entries SET rowid = -1 WHERE id = 'ent-1'")
          .run(),
      ).toThrow(/append-only/);
      // Ordinary inserts must still work (the sentinel was not poisoned).
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES ('ent-rowid-after', 'ok', '2026-01-07', '2026-01-07T10:00:00Z', 2)",
          )
          .run(),
      ).not.toThrow();
    });

    // The rowid guards treat NEW.rowid = -1 as "auto-assigned" — so a real
    // row stored at rowid -1 by raw SQL would make that sentinel match and
    // abort every ordinary insert thereafter. Negative rowids must therefore
    // be unstorable.
    it("rejects negative explicit rowids so the auto-rowid sentinel stays unambiguous", () => {
      for (const table of [
        "pluts_entries (rowid, id, description, date, posted_at, seq) VALUES (-1, 'ent-neg', 'x', '2026-01-05', '2026-01-05T10:00:00Z', 2)",
        "pluts_amounts (rowid, id, type, account_id, entry_id, amount) VALUES (-1, 'amt-neg', 'debit', 'acc-1', 'ent-1', 1)",
        "pluts_entry_keys (rowid, key, entry_id, payload_hash) VALUES (-1, 'key-neg', 'ent-1', 'cafe')",
      ]) {
        expect(() => db.prepare(`INSERT INTO ${table}`).run()).toThrow(/rowid/);
      }
      // Ordinary auto-rowid inserts still work afterwards.
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES ('ent-after', 'ok', '2026-01-06', '2026-01-06T10:00:00Z', 2)",
          )
          .run(),
      ).not.toThrow();
    });

    // Amounts above Number.MAX_SAFE_INTEGER store fine as SQLite 64-bit
    // integers but cannot cross the SqlStorage JS-number boundary on read —
    // every later read/SUM would throw in fromStorageInt. Enforce the
    // documented ceiling at write time instead.
    it("rejects an amount above Number.MAX_SAFE_INTEGER", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-big', 'debit', 'acc-1', 'ent-1', ?)",
          )
          .run(9007199254740992n),
      ).toThrow();
      // The ceiling itself is still a valid amount.
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-max', 'debit', 'acc-1', 'ent-1', ?)",
          )
          .run(9007199254740991n),
      ).not.toThrow();
    });

    // With the legacy empty-hash tolerance removed from the dedup path, a
    // key row written by raw SQL without a real fingerprint would make that
    // idempotency key conflict forever — even for genuine retries. The
    // schema must make such rows unrepresentable.
    it("rejects idempotency-key rows without a real payload hash", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entry_keys (key, entry_id) VALUES ('key-raw', 'ent-1')",
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entry_keys (key, entry_id, payload_hash) VALUES ('key-blank', 'ent-1', '')",
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entry_keys (key, entry_id, payload_hash) VALUES (?, 'ent-1', ?)",
          )
          .run("key-hashed", "b".repeat(64)),
      ).not.toThrow();
    });

    it("still accepts valid rows", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_entries (id, description, date, posted_at, seq) VALUES ('ent-2', 'ok', '2026-02-01', '2026-02-01T10:00:00Z', 2)",
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-3', 'credit', 'acc-1', 'ent-2', 500)",
          )
          .run(),
      ).not.toThrow();
    });
  });
});
