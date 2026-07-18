import type { DatabaseSync } from "node:sqlite";
import type { DurableObjectStorage } from "@cloudflare/workers-types";

type Bind = null | number | string;

class NodeSqlCursor {
  constructor(private readonly rows: Array<Record<string, unknown>>) {}
  toArray(): Array<Record<string, unknown>> {
    return this.rows;
  }
  one(): Record<string, unknown> {
    const row = this.rows[0];
    if (this.rows.length !== 1 || !row) {
      throw new Error(`Expected exactly one row, got ${this.rows.length}`);
    }
    return row;
  }
}

/**
 * A DurableObjectStorage stand-in over Node's built-in node:sqlite, exposing
 * exactly the surface SqlStorageRepository and migrate() use: `sql.exec(...)`
 * with toArray()/one() cursors, and `transactionSync(cb)`.
 *
 * node:sqlite's StatementSync.all() executes non-reader statements too
 * (returning []), so DDL, DML, and PRAGMA all flow through one path —
 * mirroring workerd's exec(). Foreign keys are enforced by default in
 * node:sqlite, matching Durable Object storage.
 *
 * This lets the production repository — where atomicity, rollback,
 * constraint mapping, and SQL range semantics actually live — run under
 * vitest against a real SQLite engine instead of only the in-memory double.
 */
export function nodeSqlStorage(db: DatabaseSync): DurableObjectStorage {
  const storage = {
    sql: {
      exec: (query: string, ...binds: Bind[]) =>
        new NodeSqlCursor(db.prepare(query).all(...binds)),
    },
    transactionSync<T>(cb: () => T): T {
      // SAVEPOINT rather than BEGIN so nested use keeps working.
      db.exec("SAVEPOINT pluts_txn");
      try {
        const result = cb();
        db.exec("RELEASE pluts_txn");
        return result;
      } catch (e) {
        db.exec("ROLLBACK TO pluts_txn");
        db.exec("RELEASE pluts_txn");
        throw e;
      }
    },
  };
  return storage as unknown as DurableObjectStorage;
}
