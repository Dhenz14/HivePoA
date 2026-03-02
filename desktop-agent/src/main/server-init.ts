/**
 * Full server initialization for the desktop agent.
 *
 * Embeds the entire Express server (154 endpoints, 42 tables) using SQLite
 * so that users visiting the GitHub Pages static site get full functionality
 * through the desktop agent alone — zero external dependencies.
 *
 * Initialization order:
 *   1. Set SQLITE_DB_PATH env var (before any server module loads)
 *   2. Create SQLite tables (raw SQL, before Drizzle touches the db)
 *   3. Run addIndexes() for query performance
 *   4. Seed default data (validators, profiles, etc.)
 *   5. Register the full 154 server routes on the agent's Express app
 */

import * as path from 'path';
import { app as electronApp } from 'electron';
import type { Express } from 'express';
import type { Server } from 'http';

/** SQLite database file path (inside Electron's userData directory) */
function getDbPath(): string {
  return path.join(electronApp.getPath('userData'), 'hivepoa.db');
}

/**
 * Initialize the full server backend with SQLite.
 *
 * IMPORTANT: Must be called BEFORE importing any server module that touches
 * the database (routes, storage, services). The env var SQLITE_DB_PATH
 * gates the storage factory in server/storage.ts.
 */
export async function initializeFullServer(
  httpServer: Server,
  app: Express,
): Promise<void> {
  const dbPath = getDbPath();

  // 1. Set env var so server/storage.ts factory picks SQLiteStorage
  process.env.SQLITE_DB_PATH = dbPath;

  // 2. Create all 42 tables (idempotent — IF NOT EXISTS)
  const { createSQLiteTables, initSQLite } = require('../../../server/db-sqlite');
  createSQLiteTables(dbPath);
  initSQLite(dbPath);
  console.log(`[SPK] SQLite database initialized at ${dbPath}`);

  // 3. Create performance indexes
  try {
    const { addIndexes } = require('../../../server/migrations/add-indexes');
    await addIndexes();
  } catch (err: any) {
    console.warn(`[SPK] Index creation warning: ${err.message}`);
  }

  // 4. Seed default data (skips if data already exists)
  try {
    const { seedDatabase } = require('../../../server/seed');
    await seedDatabase();
  } catch (err: any) {
    console.warn(`[SPK] Seed warning: ${err.message}`);
  }

  // 5. Register all 154 server routes on the agent's Express app
  const { registerRoutes } = require('../../../server/routes');
  await registerRoutes(httpServer, app);
  console.log('[SPK] Full server routes registered (154 endpoints)');
}

/**
 * Gracefully shut down the SQLite database.
 * Call this in Electron's before-quit handler.
 */
export function shutdownFullServer(): void {
  try {
    const { closeSQLite } = require('../../../server/db-sqlite');
    closeSQLite();
    console.log('[SPK] SQLite database closed');
  } catch {
    // db-sqlite may not have been imported yet if server didn't initialize
  }
}
