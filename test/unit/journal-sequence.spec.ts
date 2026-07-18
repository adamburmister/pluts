import { DatabaseSync } from "node:sqlite";
import type { SqlStorage } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";
import { Amount } from "../../src/domain/amount";
import { Ledger } from "../../src/domain/ledger";
import { AccountType } from "../../src/domain/types";
import { InMemoryRepository } from "../helpers/in-memory-repository";

/**
 * F-08: a journal is a chronological, *numbered* record. Random UUIDs give
 * identity but no order and no completeness check: same-day entries came back
 * in nondeterministic order, and nothing could show "no entries are missing".
 * Every posted entry gets a monotonically increasing seq, ordering is
 * (date, seq) everywhere, and MAX(seq) === COUNT(*) proves completeness.
 */
describe("journal sequence (in-memory)", () => {
  let ledger: Ledger;

  beforeEach(async () => {
    ledger = new Ledger(new InMemoryRepository());
    await ledger.createAccount({ name: "Cash", type: AccountType.Asset });
    await ledger.createAccount({ name: "Revenue", type: AccountType.Revenue });
  });

  function post(description: string, date: string) {
    return ledger.postEntry({
      description,
      date,
      debits: [{ accountName: "Cash", amount: Amount.fromMajor(10) }],
      credits: [{ accountName: "Revenue", amount: Amount.fromMajor(10) }],
    });
  }

  it("assigns increasing sequence numbers starting at 1", async () => {
    const first = await post("first", "2026-01-05");
    const second = await post("second", "2026-01-05");
    const third = await post("third", "2026-01-04");
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
  });

  it("orders same-date entries by posting sequence", async () => {
    await post("morning", "2026-01-05");
    await post("noon", "2026-01-05");
    await post("evening", "2026-01-05");

    const asc = await ledger.allEntries("asc");
    expect(asc.map((e) => e.description)).toEqual([
      "morning",
      "noon",
      "evening",
    ]);

    const desc = await ledger.allEntries("desc");
    expect(desc.map((e) => e.description)).toEqual([
      "evening",
      "noon",
      "morning",
    ]);
  });

  it("orders by date first, then sequence", async () => {
    await post("late but posted first", "2026-02-01");
    await post("early but posted second", "2026-01-01");
    const asc = await ledger.allEntries("asc");
    expect(asc.map((e) => e.description)).toEqual([
      "early but posted second",
      "late but posted first",
    ]);
  });

  it("verifyJournalComplete is true when the sequence has no gaps", async () => {
    await post("a", "2026-01-01");
    await post("b", "2026-01-02");
    expect(await ledger.verifyJournalComplete()).toBe(true);
  });

  it("verifyJournalComplete is true on an empty ledger", async () => {
    expect(await ledger.verifyJournalComplete()).toBe(true);
  });
});

describe("journal sequence (schema migration)", () => {
  function fakeSqlStorage(db: DatabaseSync): SqlStorage {
    return {
      exec: (query: string, ...binds: Array<string | number | null>) => {
        const rows = db.prepare(query).all(...binds);
        return { toArray: () => rows, one: () => rows[0] };
      },
    } as unknown as SqlStorage;
  }

  it("provisions fresh databases with a unique seq column", () => {
    const db = new DatabaseSync(":memory:");
    migrate(fakeSqlStorage(db));
    const cols = db
      .prepare("PRAGMA table_info(pluts_entries)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("seq");
    const indexes = db
      .prepare("PRAGMA index_list(pluts_entries)")
      .all()
      .map((i) => i.name);
    expect(indexes).toContain("pluts_entries_seq_idx");
  });

  it("backfills seq on a legacy database in insertion order", () => {
    const db = new DatabaseSync(":memory:");
    // Legacy pluts_entries: no seq column, three rows inserted over time.
    db.exec(`CREATE TABLE pluts_entries (
      id TEXT PRIMARY KEY NOT NULL,
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      posted_at TEXT NOT NULL
    )`);
    const ins = db.prepare(
      "INSERT INTO pluts_entries (id, description, date, posted_at) VALUES (?, ?, ?, ?)",
    );
    ins.run("e1", "first", "2026-01-05", "2026-01-05T10:00:00Z");
    ins.run("e2", "second", "2026-01-04", "2026-01-06T10:00:00Z");
    ins.run("e3", "third", "2026-01-06", "2026-01-07T10:00:00Z");

    migrate(fakeSqlStorage(db));

    const rows = db
      .prepare("SELECT id, seq FROM pluts_entries ORDER BY seq ASC")
      .all();
    expect(rows.map((r) => r.id)).toEqual(["e1", "e2", "e3"]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    // Idempotent: re-running must not renumber.
    migrate(fakeSqlStorage(db));
    const again = db
      .prepare("SELECT id, seq FROM pluts_entries ORDER BY seq ASC")
      .all();
    expect(again.map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});
