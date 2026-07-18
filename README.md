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
- Apply the schema in `SCHEMA_STATEMENTS` (see `src/db/schema.ts`) or translate it to your DB's DDL before first use.
- Persist amounts as integer minor units (the library uses `bigint` internally; convert to/from your driver's numeric type safely).
- Ensure `getAccountByName`, `sumByType`, `sumCredits`/`sumDebits`, and `amountsForAccount` match the SQL semantics expected by the domain code.

Examples:

- Node + SQLite: implement a `NodeSqliteRepository` using `better-sqlite3` or `sqlite3`, run the `SCHEMA_STATEMENTS` once on startup, and wrap `insertEntry` in a transaction.
- Postgres: translate the DDL (types, index syntax) and implement `Repository` methods with `pg`/`knex`; be mindful of integer sizes and use `bigint`/numeric as appropriate.

Because the domain is decoupled via `Repository` and tests exercise the domain with an in-memory repository, porting is limited to a single new repository adapter — the rest of Pluts should work unchanged.

### Tenancy

Tenancy is intentionally **not** included. Multi-tenancy is provided by Durable Object isolation: one DO instance = one ledger. Account names are unique within a ledger.

### Schema

Four tables (prefixed `pluts_`), defined in `src/db/schema.ts`:

- `pluts_accounts` — id, name, type (CHECK-constrained to the five account types), contra, created_at
- `pluts_entries` — id, description, date, posted_at
- `pluts_amounts` — id, type (`'credit'` | `'debit'`), account_id, entry_id, amount (integer minor units)
- `pluts_entry_keys` — key, entry_id (idempotency-key dedup table)

Run `migrate(ctx.storage.sql)` to apply the schema; it is idempotent and a no-op on an up-to-date database.

## Installation

```sh
bun add pluts
```

Peer dependency: `zod`. Types for the Workers runtime (`SqlStorage`, `DurableObjectStorage`, `crypto`) come from `@cloudflare/workers-types`.

## Usage

Hosted inside a Durable Object, where `ctx.storage.sql` is the ledger's database:

```ts
import { DurableObject } from "cloudflare:workers";
import {
  AccountType,
  Amount,
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

// Balances
await ledger.accountBalance(cash); // per-account
await ledger.balanceByType(AccountType.Asset); // per-type
await ledger.trialBalance(); // should be zero

// Reports
await ledger.balanceSheet(); // { assets, liabilities, equity, balanced }
await ledger.incomeStatement({ fromDate: "2024-01-01" }); // { revenue, expenses, netIncome }
```

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

### Date ranges

Balance methods accept an optional `{ fromDate, toDate }` (Date or `yyyy-mm-dd` string):

```ts
await ledger.accountBalance(cash, {
  fromDate: "2024-01-01",
  toDate: new Date(),
});
```

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
- every amount requires an account and a non-negative value
- sum(debits) === sum(credits) (exact)
- `date` defaults to today if omitted
- account names must resolve to existing accounts

## Testing

```sh
bun run test            # all tests
bun run test:unit       # domain unit tests (in-memory, fast)
bun run typecheck       # tsc --noEmit
bun run lint            # biome
```

The unit tests cover amount math, balance computation for all account types and contra variants, entry validation, and the trial balance invariant, all against an in-memory `Repository`. The `SqlStorageRepository` (production) is exercised end-to-end by the [pluts-ledger-do](https://github.com/adamburmister/pluts-ledger-do) app's Durable Object.

## Development

```sh
bun install
bun run test     # vitest (domain unit tests, in-memory)
```

Pluts is a library; the runnable Durable Object app that consumes it lives in [pluts-ledger-do](https://github.com/adamburmister/pluts-ledger-do) project. Run `npm run dev` there for a local DO with SQLite storage.

### Migrations

The schema is defined as idempotent DDL in `src/db/schema.ts` (the `SCHEMA_STATEMENTS` array). To change the schema, edit that file and add/adjust the `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements. `migrate(ctx.storage.sql)` applies them on every cold start; existing objects are skipped, so there is no separate "generate migrations" step or tracking table.

Fresh-DBs only: if you change a `CREATE TABLE` definition in a way that conflicts with an already-provisioned DO SQLite database, reset the local DO storage so it is recreated cleanly:

```sh
rm -rf ../ledger/.wrangler/state/v3/do
```

The next `npm run dev` in `ledger` provisions a fresh DO and `migrate` applies the schema cleanly.

## License

MIT
