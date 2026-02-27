/**
 * Test App Factory
 * Creates a minimal Express app with routes registered for supertest.
 * Uses the real database (requires DATABASE_URL).
 */
import express from "express";
import { createServer } from "http";
import { registerRoutes } from "../routes";

export async function createTestApp() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);

  return { app, httpServer };
}
