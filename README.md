# Pluts

A double-entry accounting ledger for TypeScript, targeting Cloudflare Durable Objects (SQLite-backed storage).

Pluts is a TypeScript refactor of the Ruby [Plutus](https://github.com/mbulat/plutus) gem. It implements a complete double-entry bookkeeping system: accounts (Asset, Liability, Equity, Revenue, Expense), journal entries with balanced debit/credit amounts, and reporting (trial balance, balance sheet, income statement).

All monetary amounts are stored as exact integer minor units (no floating-point errors), with a configurable scale (currently 2 decimal places, suitable for AUD, USD, NZD).

## Design

### Amounts

Money is represented by the `Amount` value object, stored internally as a `bigint` of minor units (cents at scale 2). The `SCALE` constant in `src/domain/amount.ts` is the single source of truth for precision. Rounding to the supported scale happens only at the input boundary, using half-up rounding; stored values are never rounded, so posted entries and the trial balance remain exact.

At public input boundaries (entry amounts, account creation), amounts accept `number | string | Amount`. A Zod schema parses raw values to `Amount` via half-up rounding at the boundary, so float imprecision (e.g. `0.1 + 0.2` = 0.30000000000000004) is resolved before storage. The stored integer is exact.

To support higher-precision currencies in the future (e.g. 3 decimals for KWD, 8 for crypto), raise `SCALE` and run a rescale migration on stored minor units. The rest of the domain is scale-agnostic.

Pro-rata splits use `Amount#allocate(weights, { remainder? })` — exact bigint math whose results always sum back to the original, with an explicit remainder policy (`"largest"` remainder by default, or `"first"`/`"last"`). Splitting $10.00 three ways yields `3.34, 3.33, 3.33` — never do this math in floats and hope the entry balances:

```ts
const [a, b, c] = Amount.fromMajor("10.00").allocate([1, 1, 1]);
```

### Accounts

The five account types are represented by the `AccountType` enum. Balance logic is driven by `normalCreditBalance(type)` plus the account's `contra` flag:

- Normal credit balance (Liability, Equity, Revenue), non-contra: `credits - debits`
- Normal credit balance, contra: `debits - credits`
- Normal debit balance (Asset, Expense), non-contra: `debits - credits`
- Normal debit balance, contra: `credits - debits`

Contra accounts are automatically subtracted from type-level balance aggregation.

### Entries

An entry requires a description, at least one debit and one credit, and the sum of debits must exactly equal the sum of credits. Validation is driven by [Zod](https://zod.dev) schemas: input shape (per-line account/amount presence, amount positivity) is validated by the schema, and entry-level invariants (≥1 debit, ≥1 credit, debits-sum === credits-sum) are enforced via `superRefine`. On failure, `Ledger.postEntry` throws a `ValidationError` carrying a flat list of path-tagged `issues`.

`Entry` (the persisted read model) and `EntryPayload` (the validated, pre-persistence input) are distinct immutable types — there is no mutable "new record" state.

### Validation

All public input boundaries are Zod-gated: entry input, account creation, amount parsing, and date ranges. `ValidationError.issues` is a flat array of `{ path: PropertyKey[]; message: string }` (Zod-native); record-level invariants use an empty path. Use `errorsByField()` to collapse paths to a field-keyed map for form binding.

### Persistence

Pluts persists over a SQLite-backed Durable Object's own storage (`ctx.storage.sql`), using the synchronous `SqlStorage` API (`sql.exec(sql, ...binds).toArray()/.one()`). The `Repository` interface decouples the domain from persistence, so the domain can be unit-tested with an in-memory repository. `SqlStorageRepository` is the production implementation.

- `src/db/schema.ts` is the single source of truth for DDL: idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements.
- `migrate(sql)` applies the schema via `sql.exec(...)`. It is idempotent and safe to run on every cold start; existing tables and indexes are left untouched. There is no separate migrations tracking table and no code generator to run.
- A ledger is hosted _inside_ a Durable Object: the DO's private SQLite database (declared via `new_sqlite_classes` in `wrangler.jsonc`) is the ledger. One DO instance = one isolated ledger. `migrate(ctx.storage.sql)` self-provisions each one, typically in the DO constructor under `blockConcurrencyWhile`.

### Serialization at boundaries

Pluts domain objects cannot cross either exit from a Durable Object:

- **Workers RPC** serializes method arguments/returns with structured clone. `bigint` is clone-safe, but class instances like `Amount` and `Entry` are rejected with `DataCloneError`.
- **JSON REST** uses `JSON.stringify`, which throws `TypeError` on `bigint`.

Returning a raw `Entry` (or any object carrying `Amount`/`Account` instances) from a DO RPC method or HTTP handler fails at runtime.

**RPC methods must return DTOs, never domain objects.** Use the mappers exported from `pluts`:

- `toEntryDTO(entry)` → `EntryDTO`
- `toAmountLineDTO(line)` → `AmountLineDTO`
- `toAccountDTO(account)` → `AccountDTO`

These produce deep-plain objects whose monetary fields are fixed-precision decimal strings (`"10.00"`), safe for both structured clone and `JSON.stringify`.

`Amount#toJSON()` returns the major-units decimal string, which makes `JSON.stringify` safe for objects containing an `Amount` — but it does **not** help Workers RPC, because structured clone ignores `toJSON`. Use the DTO mappers at RPC boundaries.

```ts
// Inside a Durable Object RPC method:
async postEntry(input: EntryInput): Promise<EntryDTO> {
  const payload = buildEntry(input, (name) => this.repository.getAccountByName(name));
  const entry = await this.repository.insertEntry(payload);
  return toEntryDTO(entry);
}
```


### SQL implementation and portability

Pluts's production persistence is implemented against Cloudflare Durable Objects' embedded SQLite via the synchronous `SqlStorage` API. The concrete implementation lives in `src/db/sqlite-storage-repository.ts` and runs the schema statements defined in `src/db/schema.ts` using `migrate(ctx.storage.sql)`.

If you want to run Pluts outside of Cloudflare (or support additional backends), implement the `Repository` interface in `src/db/repository.ts` for your chosen storage. Key guidance:

- Implement the same transactional semantics for `insertEntry` (all row inserts + idempotency-key insert must be atomic). Use your DB's transactions.
- Apply the schema in `SCHEMA_STATEMENTS` (see `src/db/schema.ts`) or translate it to your DB's DDL before first use. Note that the append-only/validation trigger statements contain internal semicolons — apply statements one at a time (as `migrate()` does); do not split `SCHEMA_SQL` naively on `;`.
- Reproduce the chart-of-accounts guards. Entries, amounts, and idempotency keys are append-only, but accounts are governed by a narrower policy: an account's `id`, `type`, `contra`, and `created_at` are immutable once created (a type or contra flip retroactively reclassifies every historical report while the trial balance still nets to zero, so nothing else in the system can detect it), while **renaming is allowed** — it is an ordinary bookkeeping operation that changes no balance, and the unique name index still bars duplicates. Deleting an account referenced by any posted amount aborts; deleting an unused one is permitted.
- Plain SQLite defaults to `PRAGMA foreign_keys = OFF` — enable it per connection (`better-sqlite3`, `node:sqlite`) or the schema's FK constraints silently won't be enforced. Durable Object storage enforces them already.
- Call `assertBalanced(payload)` (exported from `pluts`) at the top of `insertEntry` before writing anything. `EntryPayload` is structurally constructible, so the double-entry invariant must be enforced at the persistence seam, not only in the `Ledger` facade.
- Persist amounts as integer minor units (the library uses `bigint` internally; convert to/from your driver's numeric type safely).
- Ensure `getAccountByName`, `sumByType`, `sumCredits`/`sumDebits`, and `amountsForAccount` match the SQL semantics expected by the domain code.

Examples:

- Node + SQLite: implement a `NodeSqliteRepository` using `better-sqlite3` or `sqlite3`, run the `SCHEMA_STATEMENTS` once on startup, and wrap `insertEntry` in a transaction.
- Postgres: translate the DDL (types, index syntax) and implement `Repository` methods with `pg`/`knex`; be mindful of integer sizes and use `bigint`/numeric as appropriate.

Because the domain is decoupled via `Repository` and tests exercise the domain with an in-memory repository, porting is limited to a single new repository adapter — the rest of Pluts should work unchanged.

### Durable Object SQLite constraints

Verified against the real runtime by the workerd integration suite (`test/integration/`); keep these in mind when touching schema or repository code:

- **`SqlStorage` does not bind `bigint`** — every amount crosses an IEEE 754 `number` boundary at the storage seam (hence `toStorageInt`/`fromStorageInt`). The schema's `amount <= 9007199254740991` CHECK/trigger still matters: an oversized value can't be *bound*, but raw SQL can write one as a literal.
- **`PRAGMA user_version` is not supported** in DO storage — schema versioning must live in a table, which is what `pluts_ledger_meta.schema_version` does. `PRAGMA table_info` *is* allowed (the migrations rely on it).
- **`SqlStorage` handles cannot cross Durable Object contexts** — workerd throws "Cannot perform I/O on behalf of a different Durable Object". Never cache a `sql` handle outside the owning DO; in tests, keep all use inside a single `runInDurableObject` callback.
- **Everything the schema uses is authorizer-approved**: triggers with `RAISE(ABORT)`/`WHEN`, `date()` in CHECK constraints, `sqlite_master` reads, explicit rowid writes, `ON CONFLICT DO UPDATE`. If a future change reaches for something workerd rejects, the integration suite fails in CI.
- **node:sqlite is looser than workerd in one trap-prone way**: unbound placeholders silently bind as NULL there, so a test fake that drops binds can stay green while doing nothing. The workerd suite exists to catch exactly this class of gap.

### Tenancy

Tenancy is intentionally **not** included. Multi-tenancy is provided by Durable Object isolation: one DO instance = one ledger. Account names are unique within a ledger.

### Schema

Four tables (prefixed `pluts_`), defined in `src/db/schema.ts`:

- `pluts_accounts` — id, name, type (CHECK-constrained to the five account types), contra, created_at
- `pluts_entries` — id, description, date, posted_at, seq (monotonic journal number assigned at posting; entries order by `(date, seq)` and `Ledger.verifyNoSequenceGaps()` checks `MAX(seq) = COUNT(*)` — detecting any removal except a contiguous tail truncation, which would need an externally persisted high-water mark to prove)
- `pluts_amounts` — id, type (`'credit'` | `'debit'`), account_id, entry_id, amount (integer minor units)
- `pluts_entry_keys` — key, entry_id, payload_hash (idempotency-key dedup table; the hash fingerprints the posted payload so a byte-identical retry returns the original entry while reusing a key with *different* content throws `IdempotencyConflictError` instead of silently dropping the second transaction)

Run `migrate(ctx.storage.sql)` to apply the schema; it is idempotent and a no-op on an up-to-date database.

## Installation

```sh
npm install pluts
```

`zod` is a runtime dependency and is installed automatically — it validates input
at the ledger boundary but is an internal implementation detail, not part of the
public API (see [Validation](#validation) below). Types for the Workers runtime
(`SqlStorage`, `DurableObjectStorage`, `crypto`) come from
`@cloudflare/workers-types`.

## Usage

Hosted inside a Durable Object, where `ctx.storage.sql` is the ledger's database:

```ts
import { DurableObject } from "cloudflare:workers";
import {
  AccountType,
  Amount,
  entryCursor,
  type EntryCursor,
  Ledger,
  migrate,
  SqlStorageRepository,
} from "pluts";

export class LedgerDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Provision the schema before any request is served.
    ctx.blockConcurrencyWhile(() => {
      migrate(ctx.storage.sql);
      return Promise.resolve();
    });
  }

  async fetch(req: Request): Promise<Response> {
    const ledger = new Ledger(new SqlStorageRepository(this.ctx.storage));
    // ...route requests to ledger.createAccount / ledger.postEntry / reports...
    return new Response("ok");
  }
}

// Create accounts
const cash = await ledger.createAccount({
  name: "Cash",
  type: AccountType.Asset,
});
await ledger.createAccount({
  name: "Sales Revenue",
  type: AccountType.Revenue,
});
await ledger.createAccount({
  name: "Sales Tax Payable",
  type: AccountType.Liability,
});

// Post a balanced entry (debits === credits). Amounts accept number|string|Amount.
await ledger.postEntry({
  description: "Sold widgets",
  debits: [{ accountName: "Cash", amount: 50 }],
  credits: [
    { accountName: "Sales Revenue", amount: 45 },
    { accountName: "Sales Tax Payable", amount: "5.00" },
  ],
});

// Balances (point-in-time, cumulative from inception to an optional as-of date)
await ledger.accountBalance(cash); // per-account
await ledger.accountBalance(cash, "2024-12-31"); // as of a date
await ledger.balanceByType(AccountType.Asset); // per-type

// Movements (net change within a period — the flow counterpart to a balance)
await ledger.accountMovement(cash, { fromDate: "2024-01-01", toDate: "2024-12-31" });
await ledger.movementByType(AccountType.Revenue, { fromDate: "2024-01-01" });
await ledger.trialBalance(); // should be zero
await ledger.trialBalanceReport("2024-12-31"); // classic listing: per-account debit/credit columns + totals

// Reports. Balance sheet and trial balance are point-in-time (asOf);
// the income statement is a period (flow) statement and takes a range.
// `imbalance` is the residual assets - (liabilities + equity + netIncome):
// 0n in a healthy ledger. (Distinct from `trialBalanceReport`'s boolean
// `balanced` — a residual, not a verdict.)
await ledger.balanceSheet("2024-12-31"); // { assets, liabilities, equity, netIncome, imbalance }
await ledger.incomeStatement({ fromDate: "2024-01-01" }); // { revenue, expenses, netIncome }

// The journal is unbounded — page it. Bounds must be non-negative integers.
// allEntries lists in display order (date, then posting sequence); `offset`
// jumps around that listing, which is what a paged UI wants.
await ledger.allEntries("desc", { limit: 50 }); // newest 50
await ledger.allEntries("desc", { limit: 50, offset: 50 }); // the next screen

// walkEntries traverses posting order instead, and continues from a cursor.
// That is the only order in which the journal is append-only, so a walk never
// repeats or skips a row, whatever is posted or backdated while it runs.
// Ascending is open-ended (mid-walk postings are visited in turn); descending
// is a fixed tail (it covers the journal as of its first page).
let cursor: EntryCursor | undefined;
for (;;) {
  const page = await ledger.walkEntries("asc", {
    limit: 50,
    ...(cursor ? { after: cursor } : {}),
  });
  const last = page.at(-1);
  if (!last) break;
  // ...process page...
  cursor = entryCursor(last);
}
```

Every report is a **single** query, so all of its figures come from one
consistent view of the ledger: a write landing mid-report cannot produce a
trial balance that fails its own `balanced` check.

A complete runnable example lives in the [pluts-ledger-do](https://github.com/adamburmister/pluts-ledger-do) app, which wraps this pattern in a DO with a JSON REST surface and a seed route.

### Contra accounts

A contra account has its normal balance swapped:

```ts
await ledger.createAccount({
  name: "Drawing",
  type: AccountType.Equity,
  contra: true,
});
```

### Balances vs movements

A **balance** is point-in-time: cumulative from inception up to an optional
as-of date (Date or `yyyy-mm-dd` string). A **movement** is a period figure:
the net change within a `{ fromDate, toDate }` range. The distinction matters
for balance-sheet accounts — June's net cash *movement* is not the cash
*balance* — so the API keeps them separate:

```ts
await ledger.accountBalance(cash, "2024-06-30"); // balance as of 30 June
await ledger.accountMovement(cash, {
  fromDate: "2024-06-01",
  toDate: "2024-06-30",
}); // net change during June
```

Either bound of a movement range may be omitted; an unbounded movement equals
the all-time balance.

### Dates and time zones

Every date in Pluts is a bare `yyyy-mm-dd` calendar date with **no attached
offset or time**. Two rules follow from that, and both are load-bearing for
period reporting:

1. **An omitted entry `date` defaults to the UTC calendar day.**
2. **A `Date` you pass is converted using its UTC fields**, not the host's
   local zone. `new Date("2026-07-20T08:00")` in Auckland is `2026-07-19`.

East of UTC the local date runs ahead of the UTC date for part of every day:
in a zone at UTC+N, an entry posted before the local clock reaches N:00
defaults to *yesterday*. That cutoff is 08:00 in UTC+8 (AWST), 10:00 in
UTC+10 (AEST) and 13:00 in UTC+13 (NZDT) — so for an NZ ledger it covers the
whole morning. On the 1st of the month it silently files the entry into the
previous reporting period.

To get a local calendar day, construct the ledger with a `today` option:

```ts
import { Ledger, todayInTimeZone } from "pluts";

const ledger = new Ledger(repo, { today: todayInTimeZone("Pacific/Auckland") });
await ledger.postEntry({ description: "Sale", debits, credits }); // NZ-local date
```

`today` is any `() => string` returning a `yyyy-mm-dd` date; `todayInTimeZone`
throws `RangeError` at construction for an unknown IANA zone, and `utcToday`
(the default) is exported for tests and explicit opt-in. A malformed return
value is rejected rather than stored, since dates are compared
lexicographically in range queries.

Where period accuracy matters, the most robust option remains passing an
explicit `date` on every entry.

## Validation

`Ledger.postEntry` and `Ledger.createAccount` throw `ValidationError` with a flat list of path-tagged `issues` on failure:

```ts
try {
  await ledger.postEntry({ ... });
} catch (e) {
  if (e instanceof ValidationError) {
    // e.issues: { path: PropertyKey[]; message: string }[]
    // e.g. [{ path: [], message: 'The credit and debit amounts are not equal' }]
    console.log(e.issues);
    // For form binding, collapse paths to a field-keyed map:
    console.log(e.errorsByField()); // { _base: ['The credit and debit amounts are not equal'] }
  }
}
```

Rules (enforced via Zod schema + `superRefine`):

- `description` required (non-empty)
- at least one debit and one credit
- every amount requires an account and a strictly positive value (a $0.00 leg attaches an account to an entry that didn't touch it)
- sum(debits) === sum(credits) (exact)
- `date` defaults to today if omitted — **today in UTC**, see [Dates and time zones](#dates-and-time-zones)
- account names must resolve to existing accounts

Zod validates these inputs internally, but **the zod schemas are not part of the
public API**. The package exports hand-written input interfaces —
`EntryInput`, `CreateAccountInput`, `AmountInput` — and not the underlying
schema objects or their `z.input` types. This keeps zod an implementation
detail: upgrading zod (including a major bump) is not a breaking change for
consumers. The interfaces are kept in lockstep with the schemas by compile-time
assertions in `test/unit/schema-input-types.spec.ts`.

## Testing

```sh
npm test                             # both suites: unit + workerd integration
npx vitest run --project unit        # fast unit suite (node:sqlite, in-memory)
npx vitest run --project workerd     # real Durable Object SQLite (workerd)
npm run typecheck                    # tsc --noEmit
npm run lint                         # biome
```

Two test layers:

- **Unit** (`test/unit/`) — amount math, balance computation for all account types and contra variants, entry validation, the trial balance invariant, and the schema DDL semantics, against an in-memory `Repository` and `node:sqlite`.
- **workerd integration** (`test/integration/`) — runs inside the actual Workers runtime via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/), driving the production `SqlStorageRepository` and `migrate()` against a real SQLite-backed Durable Object's `ctx.storage` (no mocks). This is what proves the parts node:sqlite cannot: workerd's SQL authorizer, trigger behavior including the rowid sentinel, `transactionSync` atomicity, and the bind-type boundary.

## Development

```sh
npm ci
npm test         # vitest
```

Pluts is a library; the runnable Durable Object app that consumes it lives in [pluts-ledger-do](https://github.com/adamburmister/pluts-ledger-do) project. Run `npm run dev` there for a local DO with SQLite storage.

### Migrations

The schema is defined as idempotent DDL in `src/db/schema.ts` (the `SCHEMA_STATEMENTS` array). `migrate(ctx.storage.sql)` applies it on every cold start, then stamps the ledger's self-description into `pluts_ledger_meta`:

- `scale` — the decimal scale the stored minor units were written at. If a ledger stamped at one scale is opened by a build compiled at another, `migrate` throws instead of silently reinterpreting every stored amount; changing `SCALE` requires an explicit rescale migration.
- `schema_version` — the `SCHEMA_VERSION` constant. Databases provisioned before the meta table existed are treated as version 0 and stamped on their next migrate. Future incompatible schema changes bump the constant and add explicit upgrade steps to `migrate` — ledger data is financial record; "reset the database" is not a migration strategy.
- `currency` (optional) — pass `migrate(sql, { currency: "NZD" })` to record what the ledger's amounts denominate. Re-opening with a different currency throws, so a routing bug that sends EUR postings to a USD ledger fails at provision time instead of silently "balancing". Read it back with `getLedgerMeta(sql)`.

During local development only, a scratch DO database can still be reset by deleting `.wrangler/state/v3/do` in the consuming app.

## License

MIT
