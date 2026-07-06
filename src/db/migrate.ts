import type { D1Database } from '@cloudflare/workers-types';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { MIGRATIONS } from './migrations.js';
import { accounts, amounts, entries, entryKeys } from './schema.js';

const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Applies any pending migrations to the D1 database. Mirrors drizzle-orm 0.40.1's
 * own `migrate()` logic (same `__drizzle_migrations` tracking table, same
 * `folderMillis`/`hash` comparison) but sources migrations from the embedded
 * `MIGRATIONS` module instead of the filesystem — so it works in a deployed
 * Cloudflare Worker (no FS access) and in tests, on one code path.
 *
 * Idempotent: a database already at the latest migration is a no-op.
 */
export async function migrate(db: D1Database): Promise<void> {
  const d = drizzle(db);

  await d.run(
    sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_TABLE)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )`,
  );

  const lastApplied = await d.values<unknown[]>(
    sql`SELECT id, hash, created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY created_at DESC LIMIT 1`,
  );
  const lastDbMigration = lastApplied[0] ?? undefined;

  // `d.run(...)` returns a `SQLiteRaw` (thenable + RunnableQuery); its declared
  // type is widened to Promise, so we cast at the batch boundary (runtime
  // mirrors drizzle-orm's own `migrate()`).
  const batch: ReturnType<typeof d.run>[] = [];
  for (const migration of MIGRATIONS) {
    if (!lastDbMigration || Number(lastDbMigration[2]) < migration.folderMillis) {
      for (const stmt of migration.sql) {
        batch.push(d.run(sql.raw(stmt)));
      }
      batch.push(
        d.run(
          sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} ("hash", "created_at") VALUES(${sql.raw(`'${migration.hash}'`)}, ${sql.raw(`${migration.folderMillis}`)})`,
        ),
      );
    }
  }

  if (batch.length > 0) {
    await d.batch(batch as unknown as Parameters<typeof d.batch>[0]);
  }
}

// Re-export schema for drizzle-kit / consumers.
export { accounts, amounts, entries, entryKeys };
