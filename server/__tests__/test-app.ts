/**
 * Test App Factory
 * Creates a minimal Express app with routes registered for supertest.
 * Uses the real database (requires DATABASE_URL).
 */
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { registerRoutes } from "../routes";

export async function createTestApp() {
  const app = express();

  // CORS — matches production config in server/index.ts
  app.use(cors({
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    credentials: true,
  }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);

  return { app, httpServer };
}
