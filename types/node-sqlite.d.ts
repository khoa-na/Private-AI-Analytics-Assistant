declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string, options?: { readOnly?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }

  export class StatementSync {
    all(...params: unknown[]): unknown[];
    columns(): Array<{ name: string }>;
    run(...params: unknown[]): unknown;
  }
}
