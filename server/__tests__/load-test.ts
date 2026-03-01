/**
 * PoA Protocol Load Tests
 * Tests throughput, concurrent challenge handling, and rate limiting behavior.
 * Run with: npx vitest run server/__tests__/load-test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "./test-app";
import type { Express } from "express";
import type { Server } from "http";

let app: Express;
let httpServer: Server;

beforeAll(async () => {
  const result = await createTestApp();
  app = result.app;
  httpServer = result.httpServer;
}, 30000);

afterAll(() => {
  httpServer?.close();
});

// ============================================================
// Concurrent Request Handling
// ============================================================

describe("Concurrent Request Load", () => {
  it("handles 50 concurrent GET /api/health requests", async () => {
    const concurrency = 50;
    const start = Date.now();

    const requests = Array.from({ length: concurrency }, () =>
      request(app).get("/api/health")
    );

    const results = await Promise.all(requests);
    const elapsed = Date.now() - start;

    const successCount = results.filter(r => r.status < 500).length;
    expect(successCount).toBe(concurrency);

    // All 50 requests should complete in under 5 seconds
    expect(elapsed).toBeLessThan(5000);
  });

  it("handles 20 concurrent GET /api/stats requests", async () => {
    const concurrency = 20;

    const requests = Array.from({ length: concurrency }, () =>
      request(app).get("/api/stats")
    );

    const results = await Promise.all(requests);
    const successCount = results.filter(r => r.status === 200).length;
    expect(successCount).toBe(concurrency);
  });

  it("handles 30 concurrent GET /api/files with pagination", async () => {
    const concurrency = 30;

    const requests = Array.from({ length: concurrency }, (_, i) =>
      request(app).get(`/api/files?page=${(i % 5) + 1}&limit=10`)
    );

    const results = await Promise.all(requests);
    const successCount = results.filter(r => r.status === 200).length;
    expect(successCount).toBe(concurrency);
  });
});

// ============================================================
// Auth Rejection Under Load
// ============================================================

describe("Auth Rejection Performance", () => {
  it("rejects 50 unauthorized POST requests quickly", async () => {
    const concurrency = 50;
    const start = Date.now();

    const requests = Array.from({ length: concurrency }, () =>
      request(app)
        .post("/api/files")
        .send({ name: "test" })
    );

    const results = await Promise.all(requests);
    const elapsed = Date.now() - start;

    // All should be rejected with 401
    const rejectedCount = results.filter(r => r.status === 401).length;
    expect(rejectedCount).toBe(concurrency);

    // Auth rejection should be fast (no DB lookup needed for invalid tokens)
    expect(elapsed).toBeLessThan(3000);
  });

  it("rejects 20 requests with invalid Bearer tokens quickly", async () => {
    const concurrency = 20;
    const start = Date.now();

    const requests = Array.from({ length: concurrency }, (_, i) =>
      request(app)
        .post("/api/files")
        .set("Authorization", `Bearer fake-token-${i}`)
        .send({ name: "test" })
    );

    const results = await Promise.all(requests);
    const elapsed = Date.now() - start;

    const rejectedCount = results.filter(r => r.status === 401).length;
    expect(rejectedCount).toBe(concurrency);
    expect(elapsed).toBeLessThan(3000);
  });
});

// ============================================================
// Validator Login Rate Limiting
// ============================================================

describe("Validator Login Rate Limiting", () => {
  it("rejects excessive login attempts (>5 per minute)", async () => {
    const attempts = 8; // 5 allowed + 3 should be rate limited
    const results: number[] = [];

    for (let i = 0; i < attempts; i++) {
      const res = await request(app)
        .post("/api/validator/login")
        .send({
          username: `testuser${i}`,
          signature: "fake-sig",
          challenge: `SPK-Validator-Login-${Date.now()}`,
        });
      results.push(res.status);
    }

    // First attempts may get 400 (bad challenge) or 401 (bad sig),
    // but later ones should hit 429 (rate limited)
    const rateLimited = results.filter(s => s === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Response Time Baselines
// ============================================================

describe("Response Time Baselines", () => {
  it("GET /api/health responds under 200ms", async () => {
    const start = Date.now();
    await request(app).get("/api/health");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("GET /api/stats responds under 500ms", async () => {
    const start = Date.now();
    await request(app).get("/api/stats");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("GET /api/files responds under 500ms", async () => {
    const start = Date.now();
    await request(app).get("/api/files?page=1&limit=20");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("unauthorized POST rejection responds under 50ms", async () => {
    const start = Date.now();
    await request(app).post("/api/files").send({ name: "test" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
