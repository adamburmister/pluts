// Regression guard for issue #18: the published tarball must import cleanly in
// plain Node ESM (no bundler) and typecheck in a consumer whose tsconfig has an
// empty `types` array. Packs the real tarball (via `npm pack`, which runs the
// `prepack` build), installs it into a throwaway consumer project, then asserts
// both `import('pluts')` and `tsc --noEmit` succeed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(join(tmpdir(), "pluts-pack-"));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

try {
  // 1. Pack the real tarball (prepack builds dist/ first).
  console.log("• Packing tarball…");
  const packOut = run(
    "npm",
    ["pack", "--json", "--pack-destination", workDir],
    repoRoot,
  );
  const tarball = join(workDir, JSON.parse(packOut)[0].filename);

  // 2. Scaffold a minimal ESM consumer with an EMPTY `types` array.
  const consumer = join(workDir, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "pluts-consumer",
        private: true,
        type: "module",
        dependencies: { pluts: `file:${tarball}`, typescript: "^6.0.3" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["index.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(consumer, "index.ts"),
    [
      'import { Amount, AccountType, Ledger, SqlStorageRepository } from "pluts";',
      "const a: Amount = Amount.fromMajor(10);",
      "const t: AccountType = AccountType.Asset;",
      "void a; void t; void Ledger; void SqlStorageRepository;",
      "",
    ].join("\n"),
  );

  // 3. Install (npm auto-installs the @cloudflare/workers-types peer).
  console.log("• Installing tarball into scratch consumer…");
  run("npm", ["install", "--no-audit", "--no-fund"], consumer);

  // 4. Plain Node ESM import must succeed.
  console.log("• Importing 'pluts' in plain Node ESM…");
  run("node", ["--input-type=module", "-e", "await import('pluts')"], consumer);

  // 5. Consumer typecheck with `types: []` must pass.
  console.log("• Typechecking consumer (types: [])…");
  run(
    "node",
    [join(consumer, "node_modules", "typescript", "bin", "tsc"), "--noEmit"],
    consumer,
  );

  console.log("✓ Package imports and typechecks cleanly.");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
