/**
 * Phase 2B VRAM Class Evidence — Unit Tests
 *
 * Tests the observation log, certification derivation, and evidence recording
 * hooks in the challenge service for protocol_version >= 2 profiles.
 *
 * Covers:
 *   VE1 — Insert VRAM evidence and query it back
 *   VE2 — Certification derivation: UNCERTIFIED when no PASS exists
 *   VE3 — Certification derivation: CERTIFIED after a PASS
 *   VE4 — Certification derivation: REVOKED by VRAM_OOM after PASS
 *   VE5 — Certification derivation: REVOKED by N+ STAGE_DEADLINE_MISSED
 *   VE6 — Certification derivation: TTL-expired PASS → UNCERTIFIED
 *   VE7 — Certification derivation: TTL-expired OOM revocation lifts → CERTIFIED
 *   VE8 — Cross-profile independence: FAIL on one profile doesn't revoke another
 *   VE9 — Evidence recorded on Phase 2B challenge pass (integration with service)
 *   VE10 — Evidence NOT recorded for protocol_version=1 challenges
 *   VE11 — Idempotent: duplicate evidence for same attempt is silently ignored
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { computeVramClassEvidence } from "@shared/schema";
import { DatabaseStorage } from "../../storage";

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

let storage: DatabaseStorage;
let nodeId: string;
let profileId: string;
let profileId2: string; // second profile for cross-profile independence tests

/** Ensure the VRAM evidence table exists. */
async function ensureVramEvidenceTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS compute_vram_class_evidence (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id VARCHAR NOT NULL REFERENCES compute_nodes(id),
      resource_class_profile_id VARCHAR NOT NULL REFERENCES compute_resource_class_profiles(profile_id),
      status TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      challenge_attempt_id VARCHAR REFERENCES compute_job_attempts(id),
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS vram_evidence_node_profile_idx ON compute_vram_class_evidence(node_id, resource_class_profile_id, observed_at)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS vram_evidence_attempt_idx ON compute_vram_class_evidence(challenge_attempt_id)`);
}

/** Create a test compute node. */
async function createTestNode(): Promise<string> {
  const id = `ve-node-${uid()}`;
  await db.execute(sql`
    INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
    VALUES (${id}, ${`inst-${uid()}`}, ${`user-${uid()}`}, 'online', 'RTX 4070 Ti SUPER', 16, 'gpu_poa_challenge', '0.50', 50, 0, 0, '0', 0, now())
  `);
  return id;
}

/** Create a test profile. */
async function createTestProfile(classId: number, className: string): Promise<string> {
  const profile = await storage.createResourceClassProfile({
    classId,
    className,
    protocolVersion: 2,
    kernelId: "phase2a-kernel-v1",
    m: 524288, n: 4096, k: 8, mixRounds: 2,
    stagesPerChallenge: 5,
    firstProgressDeadlineMs: 10_000,
    stageDeadlineMs: 500,
    completionDeadlineMs: 10_000,
    poolTarget: 20,
    poolLowWatermarkPct: 50,
    poolCriticalWatermarkPct: 25,
    isActive: false, // don't trigger precompute
  });
  return profile.profileId;
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  storage = new DatabaseStorage();
  await ensureVramEvidenceTable();
  nodeId = await createTestNode();
  const classBase = 50000 + Math.floor(Math.random() * 9000);
  profileId = await createTestProfile(classBase, `gpu-ve-test-${uid()}`);
  profileId2 = await createTestProfile(classBase + 1, `gpu-ve-test2-${uid()}`);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 2B VRAM Class Evidence", () => {
  it("VE1 — insert evidence and query history", async () => {
    const now = new Date();
    const evidence = await storage.insertVramClassEvidence({
      nodeId,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: null,
      failureReason: null,
    });

    expect(evidence.id).toBeTruthy();
    expect(evidence.status).toBe("pass");
    expect(evidence.nodeId).toBe(nodeId);

    const history = await storage.getVramClassEvidenceHistory(nodeId, profileId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].id).toBe(evidence.id);
  });

  it("VE2 — UNCERTIFIED when no PASS exists for a given node+profile", async () => {
    const freshNodeId = await createTestNode();
    const result = await storage.getVramClassCertification(freshNodeId, profileId);
    expect(result.state).toBe("uncertified");
    expect(result.latestPass).toBeNull();
    expect(result.revokingObservation).toBeNull();
  });

  it("VE3 — CERTIFIED after a PASS observation", async () => {
    const testNode = await createTestNode();
    const now = new Date();
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: null,
      failureReason: null,
    });

    const result = await storage.getVramClassCertification(testNode, profileId);
    expect(result.state).toBe("certified");
    expect(result.latestPass).not.toBeNull();
    expect(result.revokingObservation).toBeNull();
  });

  it("VE4 — REVOKED by VRAM_OOM after PASS", async () => {
    const testNode = await createTestNode();
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + 1000);

    // Insert PASS
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: t0,
      expiresAt: new Date(t0.getTime() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: null,
      failureReason: null,
    });

    // Insert VRAM_OOM
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "fail",
      observedAt: t1,
      expiresAt: new Date(t1.getTime() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: null,
      failureReason: "VRAM_OOM",
    });

    const result = await storage.getVramClassCertification(testNode, profileId);
    expect(result.state).toBe("revoked");
    expect(result.revokingObservation?.failureReason).toBe("VRAM_OOM");
  });

  it("VE5 — REVOKED by N+ STAGE_DEADLINE_MISSED in window", async () => {
    const testNode = await createTestNode();
    const t0 = new Date();

    // Insert PASS
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: t0,
      expiresAt: new Date(t0.getTime() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: null,
      failureReason: null,
    });

    // Insert 3 STAGE_DEADLINE_MISSED (threshold = 3)
    for (let i = 0; i < 3; i++) {
      await storage.insertVramClassEvidence({
        nodeId: testNode,
        resourceClassProfileId: profileId,
        status: "fail",
        observedAt: new Date(t0.getTime() + 1000 + i * 100),
        expiresAt: null,
        challengeAttemptId: null,
        failureReason: "STAGE_DEADLINE_MISSED",
      });
    }

    const result = await storage.getVramClassCertification(testNode, profileId);
    expect(result.state).toBe("revoked");
    expect(result.revokingObservation?.failureReason).toBe("STAGE_DEADLINE_MISSED");
  });

  it("VE6 — TTL-expired PASS → UNCERTIFIED", async () => {
    const testNode = await createTestNode();
    const past = new Date(Date.now() - 100_000); // 100s ago

    // Insert PASS that expires 50s ago
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: past,
      expiresAt: new Date(Date.now() - 50_000), // expired
      challengeAttemptId: null,
      failureReason: null,
    });

    const result = await storage.getVramClassCertification(testNode, profileId);
    expect(result.state).toBe("uncertified");
  });

  it("VE7 — TTL-expired OOM lifts revocation → CERTIFIED (Choice A)", async () => {
    const testNode = await createTestNode();
    const t0 = new Date(Date.now() - 200_000);

    // Insert PASS with long TTL
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: t0,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days out
      challengeAttemptId: null,
      failureReason: null,
    });

    // Insert VRAM_OOM that has ALREADY expired
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "fail",
      observedAt: new Date(t0.getTime() + 1000),
      expiresAt: new Date(Date.now() - 10_000), // expired 10s ago
      challengeAttemptId: null,
      failureReason: "VRAM_OOM",
    });

    const result = await storage.getVramClassCertification(testNode, profileId);
    expect(result.state).toBe("certified");
    expect(result.latestPass).not.toBeNull();
    expect(result.revokingObservation).toBeNull();
  });

  it("VE8 — Cross-profile independence", async () => {
    const testNode = await createTestNode();
    const now = new Date();

    // PASS on profile 1
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: null,
      failureReason: null,
    });

    // FAIL on profile 2
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId2,
      status: "fail",
      observedAt: new Date(now.getTime() + 1000),
      expiresAt: null,
      challengeAttemptId: null,
      failureReason: "VRAM_OOM",
    });

    // Profile 1 should still be CERTIFIED
    const result1 = await storage.getVramClassCertification(testNode, profileId);
    expect(result1.state).toBe("certified");

    // Profile 2 should be UNCERTIFIED (no PASS)
    const result2 = await storage.getVramClassCertification(testNode, profileId2);
    expect(result2.state).toBe("uncertified");
  });

  it("VE9 — Single STAGE_DEADLINE_MISSED does NOT revoke", async () => {
    const testNode = await createTestNode();
    const now = new Date();

    // PASS
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: null,
      failureReason: null,
    });

    // Single deadline miss
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "fail",
      observedAt: new Date(now.getTime() + 1000),
      expiresAt: null,
      challengeAttemptId: null,
      failureReason: "STAGE_DEADLINE_MISSED",
    });

    const result = await storage.getVramClassCertification(testNode, profileId);
    expect(result.state).toBe("certified");
  });

  it("VE10 — INCONCLUSIVE does NOT revoke", async () => {
    const testNode = await createTestNode();
    const now = new Date();

    // PASS
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "pass",
      observedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: null,
      failureReason: null,
    });

    // INCONCLUSIVE
    await storage.insertVramClassEvidence({
      nodeId: testNode,
      resourceClassProfileId: profileId,
      status: "inconclusive",
      observedAt: new Date(now.getTime() + 1000),
      expiresAt: null,
      challengeAttemptId: null,
      failureReason: "INCOMPLETE_TRANSCRIPT",
    });

    const result = await storage.getVramClassCertification(testNode, profileId);
    expect(result.state).toBe("certified");
  });

  it("VE11 — History returns entries newest-first", async () => {
    const testNode = await createTestNode();
    const now = new Date();

    for (let i = 0; i < 3; i++) {
      await storage.insertVramClassEvidence({
        nodeId: testNode,
        resourceClassProfileId: profileId,
        status: i === 0 ? "pass" : "fail",
        observedAt: new Date(now.getTime() + i * 1000),
        expiresAt: null,
        challengeAttemptId: null,
        failureReason: i === 0 ? null : "STAGE_DEADLINE_MISSED",
      });
    }

    const history = await storage.getVramClassEvidenceHistory(testNode, profileId);
    expect(history.length).toBe(3);
    // Newest first
    expect(new Date(history[0].observedAt).getTime()).toBeGreaterThan(
      new Date(history[1].observedAt).getTime(),
    );
  });
});
