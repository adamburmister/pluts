// Bindings declared in test/integration/wrangler.jsonc, surfaced on the
// `env` import from "cloudflare:workers" inside the workerd test project.
declare namespace Cloudflare {
  interface Env {
    LEDGER_TEST: DurableObjectNamespace;
  }
}
