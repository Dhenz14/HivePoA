/**
 * Storage Tiers v1.1 — E2E Validation
 *
 * Three critical paths:
 * 1. Happy path: GET tiers → subscribe → usage reflects tier
 * 2. Hard fail: upload exceeding cap returns 413
 * 3. Top-up: existing plan blocks second subscribe (409), topup route exists
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { Server } from "http";

const AUTH_TOKEN = "canary-test-token-2026";
const AUTH_HEADER = { Authorization: `Bearer ${AUTH_TOKEN}` };

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

describe("Storage Tiers API", () => {
  it("GET /api/storage/tiers returns three tiers with correct structure", async () => {
    const res = await request(app).get("/api/storage/tiers");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(3);

    const ids = res.body.map((t: any) => t.id);
    expect(ids).toEqual(["starter", "standard", "creator"]);

    for (const tier of res.body) {
      expect(tier).toHaveProperty("id");
      expect(tier).toHaveProperty("name");
      expect(tier).toHaveProperty("storageLimitBytes");
      expect(tier).toHaveProperty("storageLimitLabel");
      expect(tier).toHaveProperty("hbdPrice");
      expect(tier).toHaveProperty("durationDays");
      expect(tier.durationDays).toBe(365);
      expect(parseFloat(tier.hbdPrice)).toBeGreaterThan(0);
      expect(tier.storageLimitBytes).toBeGreaterThan(0);
    }
  });

  it("GET /api/storage/tiers prices are correct", async () => {
    const res = await request(app).get("/api/storage/tiers");
    const tiers = res.body;
    expect(tiers[0].hbdPrice).toBe("3.999"); // Starter
    expect(tiers[1].hbdPrice).toBe("6.999"); // Standard
    expect(tiers[2].hbdPrice).toBe("11.999"); // Creator
    expect(tiers[0].storageLimitLabel).toBe("5 GB");
    expect(tiers[1].storageLimitLabel).toBe("10 GB");
    expect(tiers[2].storageLimitLabel).toBe("20 GB");
  });

  it("GET /api/storage/tiers — client cannot influence pricing", async () => {
    // Verify tiers are server-authoritative: same response regardless of query params
    const res1 = await request(app).get("/api/storage/tiers");
    const res2 = await request(app).get("/api/storage/tiers?hbdPrice=0.001&storageLimitBytes=999999999999");
    expect(res1.body).toEqual(res2.body);
  });
});

describe("Storage Usage API", () => {
  it("GET /api/storage/usage without auth returns 401", async () => {
    const res = await request(app).get("/api/storage/usage");
    expect(res.status).toBe(401);
  });

  it("GET /api/storage/usage with auth returns usage structure", async () => {
    const res = await request(app)
      .get("/api/storage/usage")
      .set(AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("usedBytes");
    expect(res.body).toHaveProperty("usedLabel");
    expect(res.body).toHaveProperty("tier");
    expect(res.body).toHaveProperty("contract");
    expect(res.body).toHaveProperty("remainingBytes");
    expect(res.body).toHaveProperty("usagePercent");
    expect(typeof res.body.usedBytes).toBe("number");
    expect(typeof res.body.usagePercent).toBe("number");
  });
});

describe("Storage Subscription", () => {
  it("POST /api/storage/subscribe without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/storage/subscribe")
      .send({ tierId: "starter" });
    expect(res.status).toBe(401);
  });

  it("POST /api/storage/subscribe with invalid tierId returns 400", async () => {
    const res = await request(app)
      .post("/api/storage/subscribe")
      .set(AUTH_HEADER)
      .send({ tierId: "mega-ultra-tier" });
    expect(res.status).toBe(400);
  });

  it("POST /api/storage/subscribe with valid tierId creates pending contract", async () => {
    const res = await request(app)
      .post("/api/storage/subscribe")
      .set(AUTH_HEADER)
      .send({ tierId: "starter" });

    // Could be 200 (created) or 409 (already has active plan)
    if (res.status === 200) {
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("depositMemo");
      expect(res.body).toHaveProperty("tier");
      expect(res.body.tier.id).toBe("starter");
      expect(res.body.storageTierId).toBe("starter");
      expect(res.body.status).toBe("pending");
      expect(res.body.hbdBudget).toBe("3.999");
      expect(res.body.depositMemo).toMatch(/^hivepoa:tier:/);
    } else {
      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("existingContractId");
    }
  });

  it("POST /api/storage/subscribe with extraHbd increases budget", async () => {
    // Clean up any existing active plan first (set to expired)
    const { db } = await import("../db");
    const { storageContracts } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    await db.update(storageContracts)
      .set({ status: "expired" })
      .where(and(
        eq(storageContracts.uploaderUsername, "canary-tester"),
        eq(storageContracts.status, "active")
      ));
    // Also expire pending ones with tier
    await db.update(storageContracts)
      .set({ status: "expired" })
      .where(and(
        eq(storageContracts.uploaderUsername, "canary-tester"),
        eq(storageContracts.status, "pending")
      ));

    const res = await request(app)
      .post("/api/storage/subscribe")
      .set(AUTH_HEADER)
      .send({ tierId: "standard", extraHbd: "5.000" });

    expect(res.status).toBe(200);
    expect(res.body.storageTierId).toBe("standard");
    // Budget should be base (6.999) + extra (5.000) = 11.999
    expect(parseFloat(res.body.totalBudget)).toBeCloseTo(11.999, 2);
  });

  it("POST /api/storage/subscribe blocks second active plan with 409", async () => {
    // First, activate the existing contract and set expiry to future
    const { db } = await import("../db");
    const { storageContracts } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const { sql } = await import("drizzle-orm");

    // Activate the most recent tier contract for this user and ensure it's not expired
    await db.update(storageContracts)
      .set({ status: "active", expiresAt: new Date(Date.now() + 365 * 86400000) })
      .where(and(
        eq(storageContracts.uploaderUsername, "canary-tester"),
        sql`${storageContracts.storageTierId} IS NOT NULL`
      ));

    // Now try to subscribe again — should get 409
    const res = await request(app)
      .post("/api/storage/subscribe")
      .set(AUTH_HEADER)
      .set("Content-Type", "application/json")
      .send({ tierId: "creator" });

    expect(res.body).toHaveProperty("error");
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Active storage plan already exists");
    expect(res.body).toHaveProperty("existingContractId");
  });
});

describe("Upload Cap Enforcement", () => {
  it("POST /api/upload/simple returns 413 when upload would exceed tier cap", async () => {
    const { db } = await import("../db");
    const { files, storageContracts } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const { sql } = await import("drizzle-orm");

    // Ensure canary-tester has an active standard tier contract
    // (previous tests may have modified state)
    const existingActive = await db.select().from(storageContracts).where(
      and(
        eq(storageContracts.uploaderUsername, "canary-tester"),
        eq(storageContracts.status, "active"),
        sql`${storageContracts.storageTierId} IS NOT NULL`,
        sql`${storageContracts.expiresAt} > NOW()`
      )
    ).limit(1);

    if (existingActive.length === 0) {
      // Create one
      await db.insert(storageContracts).values({
        fileCid: "tier:standard:canary-tester",
        uploaderUsername: "canary-tester",
        storageTierId: "standard",
        requestedReplication: 3,
        actualReplication: 0,
        status: "active",
        hbdBudget: "6.999",
        hbdSpent: "0",
        rewardPerChallenge: "0.057",
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 86400000),
      });
    }

    // Insert a file that exactly fills the 10 GB standard tier cap
    const [bigFile] = await db.insert(files).values({
      cid: `Qm-test-cap-${Date.now()}`,
      name: "big-test-file.dat",
      size: "10 GB",
      sizeBytes: 10 * 1024 * 1024 * 1024,
      uploaderUsername: "canary-tester",
      status: "pinned",
      replicationCount: 1,
      confidence: 100,
      poaEnabled: true,
    }).returning();

    try {
      // Now any upload should be rejected — user is at exactly 10 GB cap
      const res = await request(app)
        .post("/api/upload/simple")
        .set(AUTH_HEADER)
        .set("X-File-Name", "should-fail.txt")
        .set("Content-Type", "application/octet-stream")
        .send(Buffer.from("test content that should be rejected"));

      expect(res.status).toBe(413);
      expect(res.body.error).toBe("Storage limit exceeded");
      expect(res.body).toHaveProperty("tier", "standard");
      expect(res.body).toHaveProperty("limitBytes");
      expect(res.body).toHaveProperty("message");
    } finally {
      // Always clean up
      await db.delete(files).where(eq(files.id, bigFile.id));
    }
  });
});

describe("Top-Up", () => {
  it("POST /api/storage/topup without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/storage/topup")
      .send({ contractId: "fake", txHash: "fake" });
    expect(res.status).toBe(401);
  });

  it("POST /api/storage/topup with non-existent contract returns 404", async () => {
    const res = await request(app)
      .post("/api/storage/topup")
      .set(AUTH_HEADER)
      .send({ contractId: "non-existent-id", txHash: "fake-tx" });
    expect(res.status).toBe(404);
  });
});

afterAll(async () => {
  // Clean up test contracts and their events
  const { db } = await import("../db");
  const { storageContracts, contractEvents } = await import("../../shared/schema");
  const { eq, sql } = await import("drizzle-orm");
  await db.execute(sql`DELETE FROM contract_events WHERE contract_id IN (SELECT id FROM storage_contracts WHERE uploader_username = 'canary-tester')`);
  await db.delete(storageContracts).where(eq(storageContracts.uploaderUsername, "canary-tester"));
});
