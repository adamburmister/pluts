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

  // The reclassification attack the trial balance cannot see: flipping an
  // Asset to a Liability rewrites every historical report while every
  // existing check still passes.
  it("blocks reclassifying, replacing, or deleting an account", async () => {
    await seeded("attack-accounts", (sql) => {
      const acc = sql
        .exec("SELECT id, rowid FROM pluts_accounts WHERE name = 'Cash'")
        .one() as { id: string; rowid: number };

      expect(() =>
        sql
          .exec(
            "UPDATE pluts_accounts SET type = 'Liability' WHERE id = ?",
            acc.id,
          )
          .toArray(),
      ).toThrow(/immutable/);
      expect(() =>
        sql.exec("UPDATE pluts_accounts SET contra = 1").toArray(),
      ).toThrow(/immutable/);
      expect(() =>
        sql
          .exec(
            "INSERT OR REPLACE INTO pluts_accounts (rowid, id, name, type, contra, created_at) VALUES (?, 'acc-evil', 'Evil', 'Liability', 1, '2026-01-01T00:00:00Z')",
            acc.rowid,
          )
          .toArray(),
      ).toThrow(/immutable/);
      expect(() =>
        sql.exec("DELETE FROM pluts_accounts WHERE id = ?", acc.id).toArray(),
      ).toThrow(/referenced/);

      // Renames stay legal, and the classification survives every attempt.
      expect(() =>
        sql
          .exec(
            "UPDATE pluts_accounts SET name = 'Cash at bank' WHERE id = ?",
            acc.id,
          )
          .toArray(),
      ).not.toThrow();
      expect(
        sql.exec("SELECT type FROM pluts_accounts WHERE id = ?", acc.id).one(),
      ).toEqual({ type: "Asset" });
    });
  });

  it("cannot bind a bigint at all (the bind layer, isolated)", async () => {
    await seeded("attack-bigint-bind", (sql) => {
      // SqlStorage binds numbers, not bigints — the 2^53 ceiling enforced by
      // the CHECK/trigger is unreachable through this API at all. Pin that
      // boundary with a constraint-free statement, so the ONLY thing that
      // can reject here is the bind layer itself (an INSERT would also fail
      // on the safe-integer CHECK or missing FK rows, masking a change in
      // bind behavior).
      expect(() =>
        sql.exec("SELECT ? AS v", 42n as unknown as number).toArray(),
      ).toThrow();
      // Same bind layer accepts a plain number through the same statement.
      expect(sql.exec("SELECT ? AS v", 42).one()).toEqual({ v: 42 });
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
