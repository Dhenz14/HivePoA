import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

// In SQLite mode (desktop agent), DATABASE_URL is not set.
// PostgreSQL pool and db are only created when DATABASE_URL is available.
const hasPostgres = !!process.env.DATABASE_URL;

export const pool = hasPostgres
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : (null as unknown as pg.Pool);

// Cached db instance — resolved lazily on first access
let _dbInstance: any = hasPostgres ? drizzle(pool, { schema }) : null;

/**
 * Returns the active Drizzle database instance.
 * In PostgreSQL mode: returns the PG drizzle instance.
 * In SQLite mode: returns the SQLite drizzle instance (must be initialized first).
 */
export function getDb(): any {
  if (_dbInstance) return _dbInstance;
  if (process.env.SQLITE_DB_PATH) {
    const { getSQLiteDb } = require("./db-sqlite");
    _dbInstance = getSQLiteDb();
    return _dbInstance;
  }
  throw new Error("No database configured. Set DATABASE_URL or SQLITE_DB_PATH.");
}

/**
 * Lazy Proxy for the db instance.
 * Resolves to PG or SQLite Drizzle instance on first property access.
 * This allows services that `import { db }` to work transparently in both modes,
 * even if the SQLite database is initialized after module load time.
 */
export const db: any = new Proxy({}, {
  get(_target, prop) {
    const realDb = getDb();
    const value = realDb[prop];
    // Bind functions to the real db instance
    return typeof value === 'function' ? value.bind(realDb) : value;
  },
});
