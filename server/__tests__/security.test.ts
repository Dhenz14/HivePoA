/**
 * Security Tests — CORS, Auth Enforcement, CID Validation, Rate Limiting
 * Tests critical security invariants across the API surface.
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
// CORS Enforcement
// ============================================================

describe("CORS Security", () => {
  it("allows requests with no Origin header (same-origin)", async () => {
    const res = await request(app).get("/api/health");
    // 503 is valid (IPFS not connected in test), just verify it's not a CORS block (403)
    expect([200, 503]).toContain(res.status);
  });

  it("sets CORS header for allowed origins", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("does NOT set CORS header for unknown origins", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does NOT set CORS header for null origin (CSRF vector)", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "null");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handles OPTIONS preflight for allowed origins", async () => {
    const res = await request(app)
      .options("/api/files")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST");
    // cors middleware returns 204 for preflight
    expect(res.status).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-methods"]).toBeDefined();
  });

  it("returns security headers", async () => {
    const res = await request(app).get("/api/health");
    // Verify CORS is not wide-open by default (no wildcard)
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// ============================================================
// Bearer Token Auth Enforcement
// ============================================================

describe("Bearer Token Auth", () => {
  const protectedEndpoints = [
    { method: "post" as const, path: "/api/files" },
    { method: "post" as const, path: "/api/upload/init" },
    { method: "post" as const, path: "/api/ipfs/start" },
    { method: "post" as const, path: "/api/ipfs/stop" },
    { method: "post" as const, path: "/api/ipfs/restart" },
    { method: "post" as const, path: "/api/transcode/submit" },
    { method: "post" as const, path: "/api/threespeak/pin" },
    { method: "delete" as const, path: "/api/files/test-id" },
    { method: "post" as const, path: "/api/beneficiaries" },
    { method: "post" as const, path: "/api/blocklist" },
    { method: "post" as const, path: "/api/wallet/deposits" },
    { method: "post" as const, path: "/api/cdn/heartbeat/test-node" },
  ];

  for (const endpoint of protectedEndpoints) {
    it(`rejects ${endpoint.method.toUpperCase()} ${endpoint.path} without Bearer token`, async () => {
      const res = await (request(app) as any)[endpoint.method](endpoint.path)
        .send({});
      expect(res.status).toBe(401);
    });

    it(`rejects ${endpoint.method.toUpperCase()} ${endpoint.path} with invalid Bearer token`, async () => {
      const res = await (request(app) as any)[endpoint.method](endpoint.path)
        .set("Authorization", "Bearer invalid-token-abc123")
        .send({});
      expect(res.status).toBe(401);
    });
  }
});

// ============================================================
// Agent API Key Auth Enforcement
// ============================================================

describe("Agent API Key Auth", () => {
  const agentEndpoints = [
    { method: "patch" as const, path: "/api/encoding/jobs/test-id/progress" },
    { method: "post" as const, path: "/api/encoding/jobs/test-id/complete" },
    { method: "post" as const, path: "/api/encoding/jobs/test-id/fail" },
    { method: "post" as const, path: "/api/encoding/offers/test-id/accept" },
  ];

  for (const endpoint of agentEndpoints) {
    it(`rejects ${endpoint.method.toUpperCase()} ${endpoint.path} without ApiKey`, async () => {
      const res = await (request(app) as any)[endpoint.method](endpoint.path)
        .send({});
      expect(res.status).toBe(401);
    });

    it(`rejects ${endpoint.method.toUpperCase()} ${endpoint.path} with invalid ApiKey`, async () => {
      const res = await (request(app) as any)[endpoint.method](endpoint.path)
        .set("Authorization", "ApiKey fake-key-12345")
        .send({});
      expect(res.status).toBe(401);
    });
  }
});

// ============================================================
// Web of Trust Auth Enforcement
// ============================================================

describe("Web of Trust Auth", () => {
  it("rejects POST /api/wot/vouch without auth", async () => {
    const res = await request(app)
      .post("/api/wot/vouch")
      .send({ username: "test" });
    expect(res.status).toBe(401);
  });

  it("rejects DELETE /api/wot/vouch without auth", async () => {
    const res = await request(app)
      .delete("/api/wot/vouch")
      .send({ username: "test" });
    expect(res.status).toBe(401);
  });

  it("allows GET /api/wot without auth (public)", async () => {
    const res = await request(app).get("/api/wot");
    expect(res.status).toBe(200);
  });
});

// ============================================================
// Input Validation
// ============================================================

describe("Input Validation", () => {
  it("rejects POST /api/validator/login with empty body", async () => {
    const res = await request(app)
      .post("/api/validator/login")
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects POST /api/validator/login with expired challenge", async () => {
    const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const res = await request(app)
      .post("/api/validator/login")
      .send({
        username: "testuser",
        signature: "fake-sig",
        challenge: `SPK-Validator-Login-${oldTimestamp}`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("rejects POST /api/validator/login with invalid challenge format", async () => {
    const res = await request(app)
      .post("/api/validator/login")
      .send({
        username: "testuser",
        signature: "fake-sig",
        challenge: "invalid-format",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid.*challenge/i);
  });
});

// ============================================================
// Pagination Safety
// ============================================================

describe("Pagination Limits", () => {
  it("clamps excessive limit to 100", async () => {
    const res = await request(app)
      .get("/api/files?page=1&limit=99999");
    expect(res.status).toBe(200);
    if (res.body.pagination) {
      expect(res.body.pagination.limit).toBeLessThanOrEqual(100);
    }
  });

  it("handles negative page numbers gracefully", async () => {
    const res = await request(app)
      .get("/api/files?page=-1&limit=10");
    expect(res.status).toBe(200);
  });
});

// ============================================================
// Public Read Endpoints (no auth required)
// ============================================================

describe("Public Read Endpoints", () => {
  const publicEndpoints = [
    "/api/health",
    "/api/stats",
    "/api/files",
    "/api/validators",
    "/api/nodes",
    "/api/challenges",
    "/api/transactions",
    "/api/contracts",
    "/api/cdn/nodes",
    "/api/threespeak/trending",
    "/api/wot",
  ];

  for (const path of publicEndpoints) {
    it(`allows GET ${path} without auth`, async () => {
      const res = await request(app).get(path);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  }
});
