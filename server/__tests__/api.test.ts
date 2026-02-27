/**
 * API Endpoint Integration Tests
 * Tests public read endpoints and auth enforcement.
 * Requires DATABASE_URL to be set (uses real database).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Server } from "http";

let app: Express;
let httpServer: Server;

beforeAll(async () => {
  const { createTestApp } = await import("./test-app");
  const result = await createTestApp();
  app = result.app;
  httpServer = result.httpServer;
}, 30000);

afterAll(() => {
  httpServer?.close();
});

describe("Health & Stats", () => {
  it("GET /api/health returns health check data", async () => {
    const res = await request(app).get("/api/health");
    // May return 200 (all ok) or 503 (degraded — e.g. IPFS not running)
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("checks");
    expect(res.body.checks).toHaveProperty("database");
  });

  it("GET /api/stats returns aggregated stats", async () => {
    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("files");
    expect(res.body.files).toHaveProperty("total");
  });
});

describe("Public Read Endpoints", () => {
  it("GET /api/files returns an array (no pagination param)", async () => {
    const res = await request(app).get("/api/files");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/files?page=1 returns paginated response", async () => {
    const res = await request(app).get("/api/files?page=1&limit=5");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("pagination");
    expect(res.body.pagination.limit).toBe(5);
    expect(res.body.pagination.page).toBe(1);
  });

  it("GET /api/files?page=1&limit=9999 clamps limit to 100", async () => {
    const res = await request(app).get("/api/files?page=1&limit=9999");
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBeLessThanOrEqual(100);
  });

  it("GET /api/validators returns a list", async () => {
    const res = await request(app).get("/api/validators");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/nodes returns storage nodes", async () => {
    const res = await request(app).get("/api/nodes");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/challenges returns recent challenges", async () => {
    const res = await request(app).get("/api/challenges");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/transactions returns recent transactions", async () => {
    const res = await request(app).get("/api/transactions");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/contracts returns storage contracts", async () => {
    const res = await request(app).get("/api/contracts");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/cdn/nodes returns CDN nodes", async () => {
    const res = await request(app).get("/api/cdn/nodes");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/transcode/presets returns preset list", async () => {
    const res = await request(app).get("/api/transcode/presets");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("id");
    expect(res.body[0]).toHaveProperty("format");
  });

  it("GET /api/threespeak/trending returns videos", async () => {
    const res = await request(app).get("/api/threespeak/trending");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("videos");
    expect(Array.isArray(res.body.videos)).toBe(true);
  });
});

describe("Authentication Enforcement — Bearer Token", () => {
  it("POST /api/files without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/files")
      .send({ cid: "QmTest", name: "test.txt", size: "1024" });
    expect(res.status).toBe(401);
  });

  it("POST /api/upload/init without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/upload/init")
      .send({ expectedCid: "QmTest", fileName: "test.txt", fileSize: 1024, uploaderUsername: "test" });
    expect(res.status).toBe(401);
  });

  it("POST /api/ipfs/start without auth returns 401", async () => {
    const res = await request(app).post("/api/ipfs/start");
    expect(res.status).toBe(401);
  });

  it("POST /api/ipfs/stop without auth returns 401", async () => {
    const res = await request(app).post("/api/ipfs/stop");
    expect(res.status).toBe(401);
  });

  it("POST /api/ipfs/restart without auth returns 401", async () => {
    const res = await request(app).post("/api/ipfs/restart");
    expect(res.status).toBe(401);
  });

  it("POST /api/transcode/submit without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/transcode/submit")
      .send({ fileId: "1", inputCid: "QmTest", preset: "hls", requestedBy: "test" });
    expect(res.status).toBe(401);
  });

  it("POST /api/threespeak/pin without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/threespeak/pin")
      .send({ ipfs: "QmTest" });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/files/nonexistent without auth returns 401", async () => {
    const res = await request(app).delete("/api/files/nonexistent");
    expect(res.status).toBe(401);
  });

  it("POST /api/beneficiaries without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/beneficiaries")
      .send({ username: "test", weight: 50 });
    expect(res.status).toBe(401);
  });

  it("POST /api/blocklist without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/blocklist")
      .send({ cid: "QmTest", reason: "test" });
    expect(res.status).toBe(401);
  });

  it("POST /api/wallet/deposits without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/wallet/deposits")
      .send({ fromUsername: "test", hbdAmount: "1.000", txHash: "abc" });
    expect(res.status).toBe(401);
  });
});

describe("Authentication Enforcement — Agent API Key", () => {
  it("PATCH /api/encoding/jobs/:id/progress without agent auth returns 401", async () => {
    const res = await request(app)
      .patch("/api/encoding/jobs/test-id/progress")
      .send({ progress: 50 });
    expect(res.status).toBe(401);
  });

  it("POST /api/encoding/jobs/:id/complete without agent auth returns 401", async () => {
    const res = await request(app)
      .post("/api/encoding/jobs/test-id/complete")
      .send({ outputCid: "QmTest" });
    expect(res.status).toBe(401);
  });

  it("POST /api/encoding/jobs/:id/fail without agent auth returns 401", async () => {
    const res = await request(app)
      .post("/api/encoding/jobs/test-id/fail")
      .send({ errorMessage: "test" });
    expect(res.status).toBe(401);
  });

  it("POST /api/encoding/offers/:id/accept without agent auth returns 401", async () => {
    const res = await request(app)
      .post("/api/encoding/offers/test-id/accept")
      .send({ encoderId: "test" });
    expect(res.status).toBe(401);
  });
});

describe("Web of Trust Auth Enforcement", () => {
  it("POST /api/wot/vouch without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/wot/vouch")
      .send({ username: "testuser" });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/wot/vouch without auth returns 401", async () => {
    const res = await request(app).delete("/api/wot/vouch");
    expect(res.status).toBe(401);
  });

  it("GET /api/wot returns array (public)", async () => {
    const res = await request(app).get("/api/wot");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/wot/:username returns vouch status (public)", async () => {
    const res = await request(app).get("/api/wot/testuser");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("username", "testuser");
    expect(res.body).toHaveProperty("isVoucher");
    expect(res.body).toHaveProperty("isVouched");
  });
});

describe("Input Validation", () => {
  it("POST /api/validator/login with empty body returns 400", async () => {
    const res = await request(app)
      .post("/api/validator/login")
      .send({});
    expect(res.status).toBe(400);
  });

  it("Invalid Bearer token returns 401", async () => {
    const res = await request(app)
      .post("/api/files")
      .set("Authorization", "Bearer invalid-token-12345")
      .send({ cid: "QmTest", name: "test.txt", size: "1024" });
    expect(res.status).toBe(401);
  });

  it("Invalid ApiKey returns 401", async () => {
    const res = await request(app)
      .patch("/api/encoding/jobs/test-id/progress")
      .set("Authorization", "ApiKey fake-key-12345")
      .send({ progress: 50 });
    expect(res.status).toBe(401);
  });
});
