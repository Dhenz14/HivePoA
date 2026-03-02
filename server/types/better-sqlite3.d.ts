/**
 * Minimal type declarations for better-sqlite3.
 * Full types are available in the desktop-agent project via @types/better-sqlite3.
 * This stub prevents tsc errors in the root project where better-sqlite3 is not installed.
 */
declare module 'better-sqlite3' {
  interface Database {
    pragma(pragma: string): any;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }

  interface Statement {
    run(...params: any[]): RunResult;
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: any): Database;
    (filename: string, options?: any): Database;
  }

  const Database: DatabaseConstructor;
  export = Database;
}
