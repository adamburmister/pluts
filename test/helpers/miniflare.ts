import type { D1Database } from '@cloudflare/workers-types';
import { Miniflare } from 'miniflare';
import { migrate } from '../../src/db/migrate.js';

/**
 * Creates an isolated in-memory D1 database for integration testing.
 * Each instance is independent, so tests don't interfere with each other.
 */
export async function createTestD1(): Promise<D1Database> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    compatibilityDate: '2024-12-01',
    d1Databases: ['DB'],
  });

  const d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
  await migrate(d1);
  return d1;
}

/** Drops all Pluts tables (for per-test isolation without recreating the DB). */
export async function truncateAll(d1: D1Database): Promise<void> {
  await d1.exec(
    'DELETE FROM pluts_entry_keys; DELETE FROM pluts_amounts; DELETE FROM pluts_entries; DELETE FROM pluts_accounts;',
  );
}
