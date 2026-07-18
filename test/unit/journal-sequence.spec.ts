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
 * (date, seq) everywhere, and MAX(seq) === COUNT(*) detects internal gaps
 * (tail truncation is out of scope — it needs an external high-water mark).
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

  it("verifyNoSequenceGaps is true when the sequence has no gaps", async () => {
    await post("a", "2026-01-01");
    await post("b", "2026-01-02");
    expect(await ledger.verifyNoSequenceGaps()).toBe(true);
  });

  it("verifyNoSequenceGaps is true on an empty ledger", async () => {
    expect(await ledger.verifyNoSequenceGaps()).toBe(true);
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
});
