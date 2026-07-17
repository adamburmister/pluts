/**
 * Minimal ambient types for Node's built-in `node:sqlite` module, used by the
 * schema tests. The project compiles against `@cloudflare/workers-types`
 * (not `@types/node`, whose globals would conflict), so the one Node builtin
 * the test suite touches is declared here by hand.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: Array<null | number | bigint | string>): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    all(
      ...params: Array<null | number | bigint | string>
    ): Array<Record<string, unknown>>;
    get(
      ...params: Array<null | number | bigint | string>
    ): Record<string, unknown> | undefined;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
