/**
 * Seeds the local worker (default http://localhost:8787) with realistic
 * small-business demo data: a retail store's first month of operations.
 *
 * Run it against `bun run dev` (wrangler dev) in another terminal:
 *
 *   bun run dev                 # terminal 1
 *   bun run scripts/seed-demo.ts # terminal 2
 *
 * Every write carries an idempotency key, so re-running the script is safe:
 * the ledger returns the already-persisted entry instead of duplicating it.
 * Accounts are created with `if-not-exists` semantics (a 409 / ValidationError
 * on a duplicate name is treated as success).
 */

const BASE = process.env.PLUTS_BASE_URL ?? 'http://localhost:8787';

interface AccountDef {
  name: string;
  type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
  contra?: boolean;
}

interface AmountLine {
  accountName: string;
  amount: number | string;
}

interface EntryDef {
  idempotencyKey: string;
  description: string;
  date: string;
  commercialDocument?: { id: string; type: string };
  debits: AmountLine[];
  credits: AmountLine[];
}

// A small retail store ("Harbor Goods") — its opening month. Each entry is a
// plausible real-world transaction; debits always equal credits.
const ACCOUNTS: AccountDef[] = [
  // Assets
  { name: 'Cash', type: 'Asset' },
  { name: 'Checking Account', type: 'Asset' },
  { name: 'Inventory', type: 'Asset' },
  { name: 'Accounts Receivable', type: 'Asset' },
  { name: 'Equipment', type: 'Asset' },
  // Liabilities
  { name: 'Accounts Payable', type: 'Liability' },
  { name: 'Sales Tax Payable', type: 'Liability' },
  { name: 'Loan Payable', type: 'Liability' },
  // Equity
  { name: "Owner's Capital", type: 'Equity' },
  // Revenue
  { name: 'Sales Revenue', type: 'Revenue' },
  { name: 'Service Revenue', type: 'Revenue' },
  // Expenses
  { name: 'Cost of Goods Sold', type: 'Expense' },
  { name: 'Rent Expense', type: 'Expense' },
  { name: 'Salaries Expense', type: 'Expense' },
  { name: 'Utilities Expense', type: 'Expense' },
];

const ENTRIES: EntryDef[] = [
  {
    idempotencyKey: 'seed-01-capital',
    description: 'Owner invests opening capital into the business',
    date: '2026-06-01',
    debits: [{ accountName: 'Checking Account', amount: 50000 }],
    credits: [{ accountName: "Owner's Capital", amount: 50000 }],
  },
  {
    idempotencyKey: 'seed-02-equipment',
    description: 'Purchase store equipment and fixtures',
    date: '2026-06-02',
    commercialDocument: { id: 'INV-1001', type: 'Invoice' },
    debits: [{ accountName: 'Equipment', amount: 5000 }],
    credits: [{ accountName: 'Checking Account', amount: 5000 }],
  },
  {
    idempotencyKey: 'seed-03-inventory',
    description: 'Buy initial inventory on credit from supplier',
    date: '2026-06-03',
    commercialDocument: { id: 'PO-2001', type: 'PurchaseOrder' },
    debits: [{ accountName: 'Inventory', amount: 8000 }],
    credits: [{ accountName: 'Accounts Payable', amount: 8000 }],
  },
  {
    idempotencyKey: 'seed-04-cash-sale',
    description: 'Cash sale to walk-in customer (incl. 10% sales tax)',
    date: '2026-06-05',
    debits: [{ accountName: 'Cash', amount: 1100 }],
    credits: [
      { accountName: 'Sales Revenue', amount: 1000 },
      { accountName: 'Sales Tax Payable', amount: 100 },
    ],
  },
  {
    idempotencyKey: 'seed-05-rent',
    description: 'Pay monthly store rent',
    date: '2026-06-06',
    debits: [{ accountName: 'Rent Expense', amount: 1500 }],
    credits: [{ accountName: 'Checking Account', amount: 1500 }],
  },
  {
    idempotencyKey: 'seed-06-payroll',
    description: 'Pay staff salaries for the first half of the month',
    date: '2026-06-15',
    debits: [{ accountName: 'Salaries Expense', amount: 3000 }],
    credits: [{ accountName: 'Checking Account', amount: 3000 }],
  },
  {
    idempotencyKey: 'seed-07-pay-supplier',
    description: 'Partial payment to inventory supplier',
    date: '2026-06-18',
    commercialDocument: { id: 'INV-1001', type: 'Invoice' },
    debits: [{ accountName: 'Accounts Payable', amount: 4000 }],
    credits: [{ accountName: 'Checking Account', amount: 4000 }],
  },
  {
    idempotencyKey: 'seed-08-cogs',
    description: 'Recognize cost of goods sold for the month',
    date: '2026-06-30',
    debits: [{ accountName: 'Cost of Goods Sold', amount: 2500 }],
    credits: [{ accountName: 'Inventory', amount: 2500 }],
  },
  {
    idempotencyKey: 'seed-09-utilities',
    description: 'Pay electricity and water bill',
    date: '2026-06-28',
    debits: [{ accountName: 'Utilities Expense', amount: 200 }],
    credits: [{ accountName: 'Cash', amount: 200 }],
  },
  {
    idempotencyKey: 'seed-10-credit-sale',
    description: 'Sale on credit to a wholesale customer (incl. 10% sales tax)',
    date: '2026-06-25',
    commercialDocument: { id: 'INV-1002', type: 'Invoice' },
    debits: [{ accountName: 'Accounts Receivable', amount: 2200 }],
    credits: [
      { accountName: 'Sales Revenue', amount: 2000 },
      { accountName: 'Sales Tax Payable', amount: 200 },
    ],
  },
];

async function createAccount(a: AccountDef): Promise<void> {
  const res = await fetch(`${BASE}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(a),
  });
  if (res.ok) {
    const body = (await res.json()) as { id: string; name: string };
    console.log(`  + account  ${a.name.padEnd(22)} (${a.type}) -> ${body.id}`);
    return;
  }
  // A 409 / ValidationError for a duplicate (name,type) means it already
  // exists from a prior run — treat as success so seeding is idempotent.
  if (res.status >= 400 && res.status < 500) {
    const body = await res.text();
    if (/already exists|has already been taken/i.test(body)) {
      console.log(`  = account  ${a.name.padEnd(22)} already exists — skipped`);
      return;
    }
  }
  throw new Error(`createAccount(${a.name}) failed: ${res.status} ${await res.text()}`);
}

async function postEntry(e: EntryDef): Promise<void> {
  const res = await fetch(`${BASE}/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(e),
  });
  if (!res.ok) {
    throw new Error(`postEntry(${e.idempotencyKey}) failed: ${res.status} ${await res.text()}`);
  }
  console.log(`  + entry    ${e.description}`);
}

async function main(): Promise<void> {
  console.log(`Seeding ${BASE} with Harbor Goods demo data…`);
  console.log('Accounts:');
  for (const a of ACCOUNTS) await createAccount(a);
  console.log('Entries:');
  for (const e of ENTRIES) await postEntry(e);
  console.log('Done. Try:');
  console.log(`  curl ${BASE}/accounts`);
  console.log(`  curl ${BASE}/entries`);
  console.log(`  curl ${BASE}/trial-balance`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
