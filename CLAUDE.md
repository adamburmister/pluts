# Pluts — agent notes

Double-entry ledger library for Cloudflare Durable Objects (SQLite-backed
storage). See README for the full design; this file holds the working
constraints that shape code decisions.

## Testing

- Two vitest projects: `unit` (node:sqlite fakes, fast) and `workerd`
  (`test/integration/`, real DO SQLite via `@cloudflare/vitest-pool-workers`).
  `npm test` runs both. Any change to `src/db/schema.ts` or the repository
  MUST keep the workerd project green — it is the authority on what the DO
  runtime accepts.
- Write tests first (the repo's PRs follow red-green).
- node:sqlite silently binds missing placeholders as NULL; workerd does not.
  Test fakes must forward `...binds` — a fake that drops them can stay green
  while testing nothing.

## Durable Object SQLite constraints (verified in test/integration/)

- `SqlStorage` cannot bind `bigint`; amounts cross a JS-number boundary via
  `toStorageInt`/`fromStorageInt`. The 2^53−1 schema ceiling defends against
  raw SQL literals, which need no bind.
- `PRAGMA user_version` is unsupported; schema version lives in
  `pluts_ledger_meta`. `PRAGMA table_info` is allowed.
- `SqlStorage` handles must not escape their DO context (workerd throws
  "Cannot perform I/O on behalf of a different Durable Object"). In tests,
  do all storage work inside one `runInDurableObject` callback.
- Authorizer-approved and relied upon: triggers with `RAISE(ABORT)`/`WHEN`,
  `date()` in CHECKs, `sqlite_master` reads, explicit rowid writes,
  `ON CONFLICT DO UPDATE`.

## Invariants that live at specific seams

- Append-only + row validity are enforced by schema triggers, not just code;
  `migrate()` step order matters: meta table + version rollback guard →
  legacy negative-rowid repair → seq ALTER → DDL loop → seq backfill →
  scale/version/currency stamps → payload_hash backfill.
- `assertBalanced` (including per-line positivity) guards the persistence
  seam; `buildEntry`'s Zod schema guards the facade. Both must hold.
- The repository's concurrent-post recovery string-matches
  "UNIQUE constraint failed" — trigger messages on `pluts_entry_keys` must
  keep that phrase.
