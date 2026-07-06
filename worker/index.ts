import type { D1Database } from '@cloudflare/workers-types';
import { D1Repository } from '../src/db/d1-repository.js';
import { migrate } from '../src/db/migrate.js';
import { formatAmount } from '../src/domain/amount.js';
import { ValidationError } from '../src/domain/errors.js';
import { Ledger } from '../src/domain/ledger.js';
import { type CreateAccountInput, type EntryInput } from '../src/domain/schemas.js';

export interface Env {
  DB: D1Database;
}

/**
 * Pluts worker entrypoint. Provisions the D1 schema on first request and
 * exposes the ledger over a small JSON REST surface.
 *
 * Routes:
 *   POST /accounts          create an account           { name, type, contra? }
 *   GET  /accounts          list accounts (with balances)
 *   POST /entries           post a balanced entry       { description, debits, credits, … }
 *   GET  /entries           list entries (newest first)
 *   GET  /trial-balance     { balance }  (should be "0.00" for a balanced ledger)
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    await migrate(env.DB);
    const ledger = new Ledger(new D1Repository(env.DB));
    const url = new URL(req.url);

    try {
      if (req.method === 'POST' && url.pathname === '/accounts') {
        const account = await ledger.createAccount((await req.json()) as CreateAccountInput);
        return Response.json(account);
      }

      if (req.method === 'GET' && url.pathname === '/accounts') {
        const accounts = await ledger.allAccounts();
        const withBalances = await Promise.all(
          accounts.map(async (a) => ({
            ...a,
            balance: formatAmount(await ledger.accountBalance(a)),
          })),
        );
        return Response.json(withBalances);
      }

      if (req.method === 'POST' && url.pathname === '/entries') {
        const entry = await ledger.postEntry((await req.json()) as EntryInput);
        return Response.json(entry);
      }

      if (req.method === 'GET' && url.pathname === '/entries') {
        const entries = await ledger.allEntries('desc');
        return Response.json(entries);
      }

      if (req.method === 'GET' && url.pathname === '/trial-balance') {
        return Response.json({ balance: formatAmount(await ledger.trialBalance()) });
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      if (e instanceof ValidationError) {
        return Response.json({ error: e.message, issues: e.issues }, { status: 400 });
      }
      const message = e instanceof Error ? e.message : String(e);
      return Response.json({ error: message }, { status: 500 });
    }
  },
};
