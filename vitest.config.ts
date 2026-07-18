import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // Fast unit suite over node:sqlite fakes — validates domain logic and
      // SQL semantics.
      {
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          include: ["test/unit/**/*.spec.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      // workerd integration suite — the real Durable Object SQLite runtime
      // (authorizer, pragmas, triggers, binds). No mocks.
      "./test/integration/vitest.config.ts",
    ],
  },
});
