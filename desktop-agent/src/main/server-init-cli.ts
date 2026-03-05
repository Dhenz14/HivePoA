/**
 * Full server initialization for CLI/headless mode.
 *
 * Same as server-init.ts but uses ~/.spk-ipfs/hivepoa.db instead of
 * Electron's userData directory.
 */

import * as path from 'path';
import * as os from 'os';
import type { Express } from 'express';
import type { Server } from 'http';

function getDbPath(): string {
  return path.join(os.homedir(), '.spk-ipfs', 'hivepoa.db');
}

export async function initializeFullServer(
  httpServer: Server,
  app: Express,
): Promise<void> {
  const dbPath = getDbPath();

  process.env.SQLITE_DB_PATH = dbPath;

  const { createSQLiteTables, initSQLite } = require('../../../server/db-sqlite');
  createSQLiteTables(dbPath);
  initSQLite(dbPath);
  console.log(`[SPK-CLI] SQLite database initialized at ${dbPath}`);

  try {
    const { addIndexes } = require('../../../server/migrations/add-indexes');
    await addIndexes();
  } catch (err: any) {
    console.warn(`[SPK-CLI] Index creation warning: ${err.message}`);
  }

  try {
    const { seedDatabase } = require('../../../server/seed');
    await seedDatabase();
  } catch (err: any) {
    console.warn(`[SPK-CLI] Seed warning: ${err.message}`);
  }

  const { registerRoutes } = require('../../../server/routes');
  await registerRoutes(httpServer, app);
  console.log('[SPK-CLI] Full server routes registered');
}

export function shutdownFullServer(): void {
  try {
    const { closeSQLite } = require('../../../server/db-sqlite');
    closeSQLite();
    console.log('[SPK-CLI] SQLite database closed');
  } catch {}
}
