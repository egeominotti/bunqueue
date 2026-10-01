/**
 * Declaration-only stand-in for Bun's `bun:sqlite` module in the published
 * type graph. The embedded engine runs only under Bun; the portable build
 * points engine declarations here so Node, Deno and Workers consumers never
 * need Bun's global type declarations. Nothing imports this at runtime.
 */
export interface Statement {
  run(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
  values(...parameters: unknown[]): unknown[][];
  finalize(): void;
}

export interface Database {
  prepare(sql: string): Statement;
  query(sql: string): Statement;
  run(sql: string, ...parameters: unknown[]): unknown;
  exec(sql: string, ...parameters: unknown[]): unknown;
  transaction<T extends (...parameters: never[]) => unknown>(run: T): T;
  close(throwOnError?: boolean): void;
}
