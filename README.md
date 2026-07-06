# Pluts

A double-entry accounting ledger for TypeScript, targeting Cloudflare Durable Objects with D1 (SQLite).

Pluts is a TypeScript refactor of the Ruby [Plutus](https://github.com/mbulat/plutus) gem. It implements a complete double-entry bookkeeping system: accounts (Asset, Liability, Equity, Revenue, Expense), journal entries with balanced debit/credit amounts, and reporting (trial balance, balance sheet, income statement).

All monetary amounts are stored as exact integer minor units (no floating-point errors), with a configurable scale (currently 2 decimal places, suitable for AUD, USD, NZD).

## Design

### Amounts

Money is represented by the `Amount` value object, stored internally as a `bigint` of minor units (cents at scale 2). The `SCALE` constant in `src/domain/amount.ts` is the single source of truth for precision. Rounding to the supported scale happens only at the input boundary, using half-up rounding; stored values are never rounded, so posted entries and the trial balance remain exact.

At public input boundaries (entry amounts, account creation), amounts accept `number | string | Amount`. A Zod schema parses raw values to `Amount` via half-up rounding at the boundary, so float imprecision (e.g. `0.1 + 0.2` = 0.30000000000000004) is resolved before storage. The stored integer is exact.

To support higher-precision currencies in the future (e.g. 3 decimals for KWD, 8 for crypto), raise `SCALE` and run a rescale migration on stored minor units. The rest of the domain is scale-agnostic.

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

Pluts uses [Drizzle ORM](https://orm.drizzle.team) over Cloudflare D1. The `Repository` interface decouples the domain from persistence, so the domain can be unit-tested with an in-memory repository. `D1Repository` is the production implementation.

- `wrangler` runs a local D1 instance for development and testing.
- In production, Pluts is intended to be hosted within a Durable Object, where each DO instance binds to its own D1 database.

### Tenancy

Tenancy is intentionally **not** included. Multi-tenancy is provided by Durable Object isolation: one DO instance = one ledger. Account names are unique within a ledger.

### Schema

Three tables (prefixed `pluts_`):

- `pluts_accounts` — id, name, type, contra
- `pluts_entries` — id, description, date, commercial_document_id/type
- `pluts_amounts` — id, type (`'credit'` | `'debit'`), account_id, entry_id, amount (integer minor units)

Run `migrate(db)` to create them idempotently.

## Installation

```sh
bun add pluts
```

Peer dependencies: `drizzle-orm`, `zod`. For local development, `wrangler` and `miniflare` provide a D1 instance.

## Usage

```ts
import {
  AccountType,
  Amount,
  D1Repository,
  Ledger,
  migrate,
} from 'pluts';

// Inside a Durable Object (env.DB is the bound D1):
await migrate(env.DB);
const ledger = new Ledger(new D1Repository(env.DB));

// Create accounts
const cash = await ledger.createAccount({ name: 'Cash', type: AccountType.Asset });
await ledger.createAccount({ name: 'Sales Revenue', type: AccountType.Revenue });
await ledger.createAccount({ name: 'Sales Tax Payable', type: AccountType.Liability });

// Post a balanced entry (debits === credits). Amounts accept number|string|Amount.
await ledger.postEntry({
  description: 'Sold widgets',
  commercialDocument: { id: 'inv-1', type: 'Invoice' },
  debits: [{ accountName: 'Cash', amount: 50 }],
  credits: [
    { accountName: 'Sales Revenue', amount: 45 },
    { accountName: 'Sales Tax Payable', amount: '5.00' },
  ],
});

// Balances
await ledger.accountBalance(cash);                       // per-account
await ledger.balanceByType(AccountType.Asset);           // per-type
await ledger.trialBalance();                             // should be zero

// Reports
await ledger.balanceSheet();                             // { assets, liabilities, equity, balanced }
await ledger.incomeStatement({ fromDate: '2024-01-01' }); // { revenue, expenses, netIncome }
```

### Contra accounts

A contra account has its normal balance swapped:

```ts
await ledger.createAccount({ name: 'Drawing', type: AccountType.Equity, contra: true });
```

### Date ranges

Balance methods accept an optional `{ fromDate, toDate }` (Date or `yyyy-mm-dd` string):

```ts
await ledger.accountBalance(cash, { fromDate: '2024-01-01', toDate: new Date() });
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
bun run test:integration # D1 integration tests via Miniflare
bun run typecheck       # tsc --noEmit
bun run lint            # biome
```

The unit tests cover amount math, balance computation for all account types and contra variants, entry validation, and the trial balance invariant. Integration tests exercise the full D1 persistence path end-to-end.

## Development

```sh
bun install
bun run dev   # wrangler dev (local D1)
```

## License

MIT
