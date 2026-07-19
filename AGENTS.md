# AGENTS.md — pluts

Double-entry accounting ledger (TypeScript library) targeting Cloudflare Durable Objects (SQLite-backed). Single package, no monorepo.

## Commands

Use **npm** (CI runs `npm ci`). The README mentions `bun`, but CI and `.nvmrc` (Node 26) use npm — trust the CI.

```sh
npm ci                 # install (use instead of npm install)
npm run lint           # biome check src test
npm run fix            # biome check --write src test
npm run format         # biome format --write src test
npm run typecheck      # tsc --noEmit
npm test               # vitest run — BOTH projects: unit + workerd
npx vitest run --project unit      # fast unit suite (node:sqlite fakes)
npx vitest run --project workerd   # real DO SQLite (test/integration/)
npx vitest run test/unit/amount.spec.ts   # single spec
npx vitest             # watch mode
```

**Verification order matters** (matches `.github/workflows/ci.yml`):
`npm run lint` → `npm run typecheck` → `npm test`.

## Testing rules

- Write tests first (the repo's PRs follow red-green).
- Any change to `src/db/schema.ts` or the repositories MUST keep the
  `workerd` project green — it runs inside the actual Workers runtime and is
  the authority on what DO SQLite accepts.
- Test fakes for `SqlStorage` must forward `...binds`. node:sqlite silently
  binds missing placeholders as NULL, so a fake that drops them stays green
  while testing nothing (this has bitten twice).

## Architecture
- `src/index.ts` is the public API barrel — all exports for consumers go through it.
- `src/domain/` is the pure domain (decoupled from storage via the `Repository` interface in `src/db/repository.ts`). Unit tests use an in-memory repository.
- `src/db/sqlite-storage-repository.ts` = production SQLite (Durable Object `SqlStorage`) adapter. `src/db/schema.ts` = single source of truth for DDL.
- `SCALE` in `src/domain/amount.ts` is the sole precision source of truth. Money is `bigint` minor units.

## TypeScript gotchas
- `tsconfig.json` enables `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `strict`. With `verbatimModuleSyntax`, type-only re-exports/imports **must** use `export type` / `import type` (see `src/index.ts`).
- `types` includes `@cloudflare/workers-types` and `vitest/globals` (no need to import `describe`/`it`).

## Cloudflare DO serialization (runtime, not caught by typecheck/tests here)
- Workers RPC uses structured clone; JSON uses `JSON.stringify`. Neither tolerates `Amount`/`Entry` class instances (`bigint` throws `TypeError` in JSON; class instances throw `DataCloneError` over RPC).
- **RPC/HTTP handlers must return DTOs** via `toEntryDTO` / `toAmountLineDTO` / `toAccountDTO` (exported from the package). `toJSON()` on `Amount` helps JSON but NOT RPC.
- Raise `SCALE` only with a rescale migration on stored minor units.

## Durable Object SQLite constraints (verified in test/integration/)
- `SqlStorage` cannot bind `bigint`; amounts cross a JS-number boundary via
  `toStorageInt`/`fromStorageInt`. The schema's 2^53−1 amount ceiling defends
  against raw SQL literals, which need no bind.
- `PRAGMA user_version` is unsupported; schema version lives in
  `pluts_ledger_meta`. `PRAGMA table_info` is allowed.
- `SqlStorage` handles must not escape their DO context (workerd throws
  "Cannot perform I/O on behalf of a different Durable Object"). In tests,
  do all storage work inside one `runInDurableObject` callback.
- Authorizer-approved and relied upon: triggers with `RAISE(ABORT)`/`WHEN`,
  `date()` in CHECKs, `sqlite_master` reads, explicit rowid writes,
  `ON CONFLICT DO UPDATE`.

## Migrations
No external migration tool. Schema = idempotent `CREATE TABLE/INDEX/TRIGGER
IF NOT EXISTS` in `src/db/schema.ts`; `migrate(ctx.storage.sql)` runs on
every cold start and stamps `pluts_ledger_meta` (scale, `schema_version`,
optional currency). `migrate()` carries **no data-migration steps** — the
project is greenfield, so every schema change so far has been expressible as
idempotent DDL alone.

**Step order inside `migrate()` is load-bearing**: meta table DDL → version
rollback guard → DDL loop → scale check → scale/`schema_version`/currency
stamps. The rollback guard must precede all other DDL (a build older than the
stored version must refuse *before* running statements a newer release may
have reshaped), and the version stamp comes last so a failure part-way leaves
the old version recorded and the migration retries.

Future incompatible changes bump `SCHEMA_VERSION` and add explicit upgrade
steps — never "reset the database". A data step that repairs existing rows
goes **before the DDL loop** when the new triggers would reject the repair
itself (e.g. relocating rows a new trigger would freeze), and after it when
the step needs the new schema shape. (Local dev scratch DBs can still be
reset with `rm -rf .wrangler/state/v3/do` in the consuming app.)

## Invariants that live at specific seams
- Append-only + row validity are enforced by schema triggers, not just code.
- `assertBalanced` (including per-line positivity) guards the persistence
  seam; `buildEntry`'s Zod schema guards the facade. Both must hold.
- The repository's concurrent-post recovery string-matches
  "UNIQUE constraint failed" — trigger messages on `pluts_entry_keys` must
  keep that phrase.

## CI / publish
- `ci.yml`: lint → typecheck → test on push to `main` and all PRs.
- `publish.yml`: on GitHub release, runs `npm test`, syncs version from the `vX.Y.Z` tag (`npm version "${GITHUB_REF_NAME#v}"`), then `npm publish --provenance`.

## Secrets
- `.env` is gitignored but **is committed locally with a real `NPM_TOKEN`** in this checkout. Do not commit it, and flag if it leaks. `.env.example` is the only allowed-in-repo env template.

## Coding principles

- Prefer clean and human readable code to terse, compact code.
- Do not consider backwards compatibility. This is a greenfield project without current users.
