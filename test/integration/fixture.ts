import { DurableObject } from "cloudflare:workers";

/**
 * Minimal Durable Object fixture for the workerd integration suite. Tests
 * reach inside it with `runInDurableObject` from `cloudflare:test` and drive
 * the real `ctx.storage` (SQLite) directly — the class itself needs no
 * behavior. It intentionally does NOT run migrate() in its constructor so
 * tests can exercise legacy/partial database states first.
 */
export class LedgerTestDO extends DurableObject {}

export default {
  // vitest-pool-workers requires a default export for the entry worker; the
  // integration tests never fetch it.
  async fetch(): Promise<Response> {
    return new Response("pluts integration fixture");
  },
};
