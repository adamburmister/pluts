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
npm test               # vitest run (all specs in test/**/*.spec.ts)
npx vitest run test/unit/amount.spec.ts   # single spec
npx vitest             # watch mode
```

**Verification order matters** (matches `.github/workflows/ci.yml`):
`npm run lint` → `npm run typecheck` → `npm test`.

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

## Migrations
No migration tool or tracking table. Schema = idempotent `CREATE TABLE/INDEX IF NOT EXISTS` in `src/db/schema.ts`; `migrate(ctx.storage.sql)` runs on every cold start. To change schema, edit `SCHEMA_STATEMENTS` and deploy; reset local DO state (`rm -rf .wrangler/state/v3/do`) for fresh-DB schema changes.

## CI / publish
- `ci.yml`: lint → typecheck → test on push to `main` and all PRs.
- `publish.yml`: on GitHub release, runs `npm test`, syncs version from the `vX.Y.Z` tag (`npm version "${GITHUB_REF_NAME#v}"`), then `npm publish --provenance`.

## Secrets
- `.env` is gitignored but **is committed locally with a real `NPM_TOKEN`** in this checkout. Do not commit it, and flag if it leaks. `.env.example` is the only allowed-in-repo env template.

## Coding principles

- Prefer clean and human readable code to terse, compact code.
- Do not consider backwards compatibility. This is a greenfield project without current users.
