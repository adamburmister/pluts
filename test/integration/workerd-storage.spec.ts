import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  DurableObjectStorage,
  SqlStorage,
} from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { getLedgerMeta, migrate, SCHEMA_VERSION } from "../../src/db/schema";
import { SqlStorageRepository } from "../../src/db/sqlite-storage-repository";
import { Amount, SCALE } from "../../src/domain/amount";
import { RepositoryError, ValidationError } from "../../src/domain/errors";
import { Ledger } from "../../src/domain/ledger";
import { AccountType } from "../../src/domain/types";

/**
 * Integration suite against REAL Durable Object SQLite storage (workerd).
 *
 * The unit suite validates SQL semantics via node:sqlite; this suite
 * validates the parts only the real runtime can prove: workerd's SQL
 * authorizer (which pragmas/DDL are permitted), trigger behavior including
 * the rowid sentinel, transactionSync atomicity, and the bind-type
 * boundary. Each test uses its own DO id, i.e. its own private database.
 */

// Reach the real storage of a fresh, isolated Durable Object.
function withStorage<T>(
  name: string,
  fn: (storage: DurableObjectStorage, sql: SqlStorage) => T | Promise<T>,
): Promise<T> {
  const stub = env.LEDGER_TEST.get(env.LEDGER_TEST.idFromName(name));
  return runInDurableObject(stub, (_instance, state) =>
    fn(
      state.storage as unknown as DurableObjectStorage,
      state.storage.sql as unknown as SqlStorage,
    ),
  );
}

describe("migrate on real DO SQLite", () => {
  it("provisions and is idempotent (authorizer accepts all DDL)", async () => {
    await withStorage("migrate-idempotent", (_storage, sql) => {
      migrate(sql);
      migrate(sql); // second run must be a no-op, not an error
      const tables = sql
        .exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pluts_%' ORDER BY name",
        )
        .toArray()
        .map((r) => r.name);
      expect(tables).toContain("pluts_accounts");
      expect(tables).toContain("pluts_entries");
      expect(tables).toContain("pluts_amounts");
      expect(tables).toContain("pluts_entry_keys");
      expect(tables).toContain("pluts_ledger_meta");
    });
  });

  it("stamps scale and schema_version; refuses newer versions", async () => {
    await withStorage("migrate-meta", (_storage, sql) => {
      migrate(sql);
      const meta = getLedgerMeta(sql);
      expect(meta.scale).toBe(SCALE);
      expect(meta.schemaVersion).toBe(SCHEMA_VERSION);

      sql
        .exec(
          "UPDATE pluts_ledger_meta SET value = ? WHERE key = 'schema_version'",
          String(SCHEMA_VERSION + 1),
        )
        .toArray();
      expect(() => migrate(sql)).toThrow(RepositoryError);
    });
  });

  it("records and defends the ledger currency", async () => {
    await withStorage("migrate-currency", (_storage, sql) => {
      migrate(sql, { currency: "NZD" });
      expect(getLedgerMeta(sql).currency).toBe("NZD");
      expect(() => migrate(sql, { currency: "EUR" })).toThrow(RepositoryError);
    });
  });

  it("repairs a legacy rowid -1 row before the guards exist", async () => {
    await withStorage("legacy-rowid-repair", (_storage, sql) => {
      // A database as a pre-guard release left it: tables, no triggers.
      sql
        .exec(
          `CREATE TABLE pluts_entries (
            id TEXT PRIMARY KEY NOT NULL,
            description TEXT NOT NULL,
            date TEXT NOT NULL,
            posted_at TEXT NOT NULL
          )`,
        )
        .toArray();
      sql
        .exec(
          "INSERT INTO pluts_entries (rowid, id, description, date, posted_at) VALUES (-1, 'ent-legacy', 'old', '2026-01-05', 't')",
        )
        .toArray();

      migrate(sql);

      const row = sql
        .exec("SELECT rowid FROM pluts_entries WHERE id = 'ent-legacy'")
        .one() as { rowid: number };
      expect(row.rowid).toBeGreaterThan(0);
      // Ordinary inserts are not bricked by the -1 sentinel.
      expect(() =>
        sql
          .exec(
            "INSERT INTO pluts_entries (id, description, date, posted_at) VALUES ('ent-new', 'ok', '2026-01-06', 't')",
          )
          .toArray(),
      ).not.toThrow();
    });
  });
});

describe("append-only and validity triggers on real DO SQLite", () => {
  // SqlStorage handles cannot leave their Durable Object's context (workerd
  // enforces this), so the seeded fixture takes a continuation instead of
  // returning handles.
  async function seeded(
    name: string,
    fn: (sql: SqlStorage, ledger: Ledger) => Promise<void> | void,
  ): Promise<void> {
    await withStorage(name, async (storage, sql) => {
      migrate(sql);
      const ledger = new Ledger(new SqlStorageRepository(storage));
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });
      await ledger.postEntry({
        idempotencyKey: "seed-1",
        description: "Sale",
        date: "2026-01-05",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      });
      await fn(sql, ledger);
    });
  }

  it("blocks UPDATE and DELETE of posted records", async () => {
    await seeded("attack-update-delete", (sql) => {
      expect(() =>
        sql
          .exec("UPDATE pluts_entries SET description = 'rewritten'")
          .toArray(),
      ).toThrow(/append-only/);
      expect(() => sql.exec("DELETE FROM pluts_amounts").toArray()).toThrow(
        /append-only/,
      );
      expect(() =>
        sql.exec("UPDATE pluts_entry_keys SET entry_id = 'x'").toArray(),
      ).toThrow(/append-only/);
    });
  });

  it("blocks INSERT OR REPLACE via id and via rowid", async () => {
    await seeded("attack-replace", (sql) => {
      const amt = sql
        .exec("SELECT id, rowid FROM pluts_amounts LIMIT 1")
        .one() as { id: string; rowid: number };
      expect(() =>
        sql
          .exec(
            "INSERT OR REPLACE INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES (?, 'debit', 'x', 'y', 1)",
            amt.id,
          )
          .toArray(),
      ).toThrow(/append-only/);
      expect(() =>
        sql
          .exec(
            "INSERT OR REPLACE INTO pluts_amounts (rowid, id, type, account_id, entry_id, amount) VALUES (?, 'amt-evil', 'debit', 'x', 'y', 1)",
            amt.rowid,
          )
          .toArray(),
      ).toThrow(/append-only/);
    });
  });

  it("blocks rowid reassignment and negative-rowid inserts", async () => {
    await seeded("attack-rowid", (sql) => {
      expect(() =>
        sql
          .exec("UPDATE pluts_entries SET rowid = -1 WHERE rowid > 0")
          .toArray(),
      ).toThrow(/append-only/);
      expect(() =>
        sql
          .exec(
            "INSERT INTO pluts_entries (rowid, id, description, date, posted_at) VALUES (-1, 'ent-neg', 'x', '2026-01-06', 't')",
          )
          .toArray(),
      ).toThrow(/rowid/);
      // The auto-rowid sentinel does not false-positive on normal inserts.
      expect(() =>
        sql
          .exec(
            "INSERT INTO pluts_entries (id, description, date, posted_at) VALUES ('ent-ok', 'ok', '2026-01-06', 't')",
          )
          .toArray(),
      ).not.toThrow();
    });
  });

  it("rejects malformed and impossible dates, and invalid amount rows", async () => {
    await seeded("attack-validity", (sql) => {
      for (const bad of [
        "not-a-date",
        "2026-1-5",
        "2026-02-30",
        "2026-13-01",
      ]) {
        expect(() =>
          sql
            .exec(
              "INSERT INTO pluts_entries (id, description, date, posted_at) VALUES (?, 'bad', ?, 't')",
              `ent-${bad}`,
              bad,
            )
            .toArray(),
        ).toThrow();
      }
      expect(() =>
        sql
          .exec(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-bad', 'sideways', 'a', 'e', 1)",
          )
          .toArray(),
      ).toThrow();
      expect(() =>
        sql
          .exec(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-float', 'debit', 'a', 'e', 1.5)",
          )
          .toArray(),
      ).toThrow();
    });
  });

  it("cannot even bind an amount beyond the JS safe-integer range", async () => {
    await seeded("attack-bigint-bind", (sql) => {
      // SqlStorage binds numbers, not bigints — the 2^53 ceiling enforced by
      // the CHECK/trigger is unreachable through this API at all. Pin that
      // boundary assumption.
      expect(() =>
        sql
          .exec(
            "INSERT INTO pluts_amounts (id, type, account_id, entry_id, amount) VALUES ('amt-big', 'debit', 'a', 'e', ?)",
            9007199254740992n as unknown as number,
          )
          .toArray(),
      ).toThrow();
    });
  });
});

describe("Ledger over the production repository on real DO SQLite", () => {
  it("posts, balances, sequences, and dedups idempotent retries", async () => {
    await withStorage("ledger-flow", async (storage, sql) => {
      migrate(sql);
      const ledger = new Ledger(new SqlStorageRepository(storage));
      await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
      await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });

      const input = {
        idempotencyKey: "req-1",
        description: "Sale",
        date: "2026-01-05",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(100) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(100) }],
      };
      const first = await ledger.postEntry(input);
      expect(first.seq).toBe(1);

      // Genuine retry returns the original entry (fingerprint match).
      const retry = await ledger.postEntry({ ...input });
      expect(retry.id).toBe(first.id);
      expect(await ledger.allEntries()).toHaveLength(1);

      // Same key, different payload: loud conflict, nothing written.
      await expect(
        ledger.postEntry({
          ...input,
          debits: [{ accountName: "Cash", amount: Amount.fromMajor(999) }],
          credits: [{ accountName: "Revenue", amount: Amount.fromMajor(999) }],
        }),
      ).rejects.toMatchObject({ name: "IdempotencyConflictError" });

      const second = await ledger.postEntry({
        description: "Sale 2",
        date: "2026-01-06",
        debits: [{ accountName: "Cash", amount: Amount.fromMajor(50) }],
        credits: [{ accountName: "Revenue", amount: Amount.fromMajor(50) }],
      });
      expect(second.seq).toBe(2);

      expect(await ledger.trialBalance()).toBe(0n);
      expect(await ledger.verifyNoSequenceGaps()).toBe(true);
    });
  });

  it("rolls back the whole posting on failure (transactionSync)", async () => {
    await withStorage("ledger-atomicity", async (storage, sql) => {
      migrate(sql);
      const repo = new SqlStorageRepository(storage);
      const ledger = new Ledger(repo);
      const cash = await ledger.createAccount({
        name: "Cash",
        type: AccountType.Asset,
      });
      const rev = await ledger.createAccount({
        name: "Revenue",
        type: AccountType.Revenue,
      });

      // Guard-path sanity: an unbalanced payload is rejected by
      // assertBalanced BEFORE the transaction opens — nothing written.
      await expect(
        repo.insertEntry({
          description: "unbalanced",
          date: "2026-01-05",
          debits: [{ account: cash, amount: Amount.fromMajor(10) }],
          credits: [{ account: rev, amount: Amount.fromMajor(1) }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      // Transaction path: a BALANCED payload that fails INSIDE
      // transactionSync. Post once with a key, then hit the repository
      // directly (bypassing Ledger's dedup pre-check) with the same key and
      // different content: the entry and amount INSERTs succeed inside the
      // transaction, then the key INSERT hits the unique constraint — the
      // whole posting must roll back, leaving only the original rows.
      const original = await repo.insertEntry({
        idempotencyKey: "atomic-key",
        description: "original",
        date: "2026-01-05",
        debits: [{ account: cash, amount: Amount.fromMajor(10) }],
        credits: [{ account: rev, amount: Amount.fromMajor(10) }],
      });
      await expect(
        repo.insertEntry({
          idempotencyKey: "atomic-key",
          description: "collides inside the transaction",
          date: "2026-01-06",
          debits: [{ account: cash, amount: Amount.fromMajor(99) }],
          credits: [{ account: rev, amount: Amount.fromMajor(99) }],
        }),
      ).rejects.toMatchObject({
        name: "IdempotencyConflictError",
        existingEntryId: original.id,
      });

      // Only the original posting survives: its entry, its two amounts, its
      // key row. The collided posting's rows were written inside the
      // transaction and must all be gone.
      const counts = sql
        .exec(
          "SELECT (SELECT COUNT(*) FROM pluts_entries) AS e, (SELECT COUNT(*) FROM pluts_amounts) AS a, (SELECT COUNT(*) FROM pluts_entry_keys) AS k",
        )
        .one() as { e: number; a: number; k: number };
      expect(counts).toEqual({ e: 1, a: 2, k: 1 });
      expect(
        sql
          .exec(
            "SELECT COUNT(*) AS n FROM pluts_entries WHERE description = 'collides inside the transaction'",
          )
          .one(),
      ).toEqual({ n: 0 });
    });
  });
});
