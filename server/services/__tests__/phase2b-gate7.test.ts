/**
 * Phase 2B Gate 7 — Post-Insertion Validation
 *
 * End-to-end validation that Phase 2B profiles (protocol_version=2) correctly
 * record VRAM class evidence through the challenge pipeline.
 *
 * Self-contained: creates its own profiles + bundles (does NOT consume production pool).
 *
 * Tests:
 *   G7-1 — Challenge against v2 profile sets protocol_version=2 on attempt
 *   G7-2 — Full challenge pass: all stages → CERTIFIED evidence recorded
 *   G7-3 — Challenge failure → FAIL evidence recorded with reason
 *   G7-4 — OOM evidence revokes certification
 *   G7-5 — Cross-profile independence: profile A REVOKED, profile B CERTIFIED
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../db";
import { sql, eq } from "drizzle-orm";
import { computeJobAttempts, computeChallengeCheckpoints } from "@shared/schema";
import { DatabaseStorage } from "../../storage";

// ── Helpers ──────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

let storage: DatabaseStorage;
let profileA: string; // Gate 7 test profile A
let profileB: string; // Gate 7 test profile B
const STAGES = 5;

/** Create a test compute node. */
async function createTestNode(): Promise<string> {
  const id = `g7-node-${uid()}`;
  await db.execute(sql`
    INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at, last_poa_challenge_at)
    VALUES (${id}, ${`inst-${uid()}`}, ${`user-${uid()}`}, 'online', 'RTX 4070 Ti SUPER', 16, 'gpu_poa_challenge', '0.50', 50, 0, 0, '0', 0, now(), now() - interval '2 hours')
  `);
  return id;
}

/** Create a test profile with protocol_version=2 (Phase 2B). */
async function createTestProfile(): Promise<string> {
  const classId = 90000 + Math.floor(Math.random() * 9000);
  const profile = await storage.createResourceClassProfile({
    classId,
    className: `g7-test-${uid()}`,
    protocolVersion: 2,
    kernelId: "phase2a-kernel-v1",
    m: 524288, n: 4096, k: 8, mixRounds: 2,
    stagesPerChallenge: STAGES,
    firstProgressDeadlineMs: 60_000,
    stageDeadlineMs: 60_000,
    completionDeadlineMs: 60_000,
    poolTarget: 20,
    poolLowWatermarkPct: 50,
    poolCriticalWatermarkPct: 25,
    isActive: false, // don't trigger precompute
  });
  return profile.profileId;
}

/** Create a bundle set for a profile (synthetic test data). */
async function createBundleSet(profileId: string): Promise<string> {
  const { randomUUID, createHash } = await import("crypto");
  const setId = randomUUID();
  const rootNonce = randomUUID();

  const bundles = [];
  for (let i = 0; i < STAGES; i++) {
    const stageNonce = randomUUID();
    const digest = createHash("sha256").update(`${rootNonce}-${i}-${stageNonce}`).digest("hex");

    bundles.push({
      challengeSetId: setId,
      profileId,
      stageIndex: i,
      rootNonce,
      stageNonce,
      expectedDigest: digest,
      workloadParamsJson: JSON.stringify({ m: 524288, n: 4096, k: 8, mix_rounds: 2 }),
    });
  }

  await storage.insertPrecomputedBundleSet(bundles);
  return setId;
}

/** Issue a challenge using direct storage primitives. */
async function issueChallenge(nodeId: string, profileId: string): Promise<{
  jobId: string;
  attemptId: string;
  bundles: any[];
}> {
  const { randomUUID, createHash } = await import("crypto");

  const manifestJson = JSON.stringify({
    type: "gpu_poa_challenge", protocol: "phase2a", protocol_version: 2,
    target_node_id: nodeId, profile_id: profileId,
  });
  const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

  const job = await storage.createComputeJob({
    creatorUsername: "gate7-validator",
    workloadType: "gpu_poa_challenge",
    state: "queued",
    priority: 10,
    manifestJson, manifestSha256,
    minVramGb: 0, requiredModels: "",
    budgetHbd: "0.000", reservedBudgetHbd: "0.000",
    leaseSeconds: 600, maxAttempts: 1,
    targetNodeId: nodeId,
    deadlineAt: new Date(Date.now() + 900_000),
  });

  const attempt = await storage.createComputeJobAttempt({
    jobId: job.id, nodeId,
    leaseToken: randomUUID(), nonce: randomUUID(),
    state: "leased",
    leaseExpiresAt: new Date(Date.now() + 600_000),
  });

  const bundles = await storage.claimOrphanChallengeSet(profileId, job.id, attempt.id);
  if (!bundles) throw new Error(`No bundles available for ${profileId}`);

  await storage.revealChallengeStage(attempt.id, 0);
  await storage.updateComputeJobState(job.id, "leased");

  return { jobId: job.id, attemptId: attempt.id, bundles };
}

/** Simulate passing all stages with correct checkpoints. */
async function passAllStages(attemptId: string, bundles: any[]): Promise<void> {
  const { createHash } = await import("crypto");
  const sorted = [...bundles].sort((a: any, b: any) => a.stageIndex - b.stageIndex);
  let prevHash = ""; // stage 0 genesis

  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const entryHash = createHash("sha256").update(`${prevHash}${i}${b.expectedDigest}`).digest("hex");

    const result = await storage.acceptChallengeCheckpoint(
      attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash, new Date(),
    );
    if ("error" in result) throw new Error(`Checkpoint ${i} rejected: ${result.error}`);
    prevHash = entryHash;
  }
}

/** Score a challenge and record VRAM evidence (simulating service flow). */
async function scoreAndRecordEvidence(
  attemptId: string,
  passed: boolean,
  failureReason: string | null = null,
): Promise<void> {
  const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, attemptId));
  if (!attempt || !attempt.challengeProfileId) throw new Error("Attempt not found or no profile");

  // Score
  const state = passed ? "accepted" : "rejected";
  await storage.updateComputeJobState(attempt.jobId, state, { completedAt: new Date() });
  await storage.updateComputeJobAttempt(attemptId, { state, finishedAt: new Date() });

  // Record VRAM evidence (replicating Phase2AChallengeService.recordVramEvidence)
  if (attempt.challengeProtocolVersion && attempt.challengeProtocolVersion >= 2) {
    await storage.insertVramClassEvidence({
      nodeId: attempt.nodeId,
      resourceClassProfileId: attempt.challengeProfileId,
      status: passed ? "pass" : "fail",
      observedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      challengeAttemptId: attempt.id,
      failureReason: passed ? null : (failureReason ?? "STAGE_DIGEST_MISMATCH"),
    });
  }
}

// ── Setup ────────────────────────────────────────────────────────

beforeAll(async () => {
  storage = new DatabaseStorage();
  profileA = await createTestProfile();
  profileB = await createTestProfile();
  // Seed 10 bundle sets per profile (enough for all tests)
  for (let i = 0; i < 10; i++) {
    await createBundleSet(profileA);
    await createBundleSet(profileB);
  }
});

// ── Tests ────────────────────────────────────────────────────────

describe("Phase 2B Gate 7 — Post-Insertion Validation", () => {
  it("G7-1 — Challenge sets protocol_version=2 and profileId on attempt", async () => {
    const nodeId = await createTestNode();
    const { attemptId } = await issueChallenge(nodeId, profileA);

    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, attemptId));
    expect(attempt.challengeProtocolVersion).toBe(2);
    expect(attempt.challengeProfileId).toBe(profileA);
  });

  it("G7-2 — Full challenge pass records CERTIFIED VRAM evidence", async () => {
    const nodeId = await createTestNode();
    const { attemptId, bundles } = await issueChallenge(nodeId, profileA);

    await passAllStages(attemptId, bundles);
    await scoreAndRecordEvidence(attemptId, true);

    const cert = await storage.getVramClassCertification(nodeId, profileA);
    expect(cert.state).toBe("certified");
    expect(cert.latestPass?.challengeAttemptId).toBe(attemptId);

    const history = await storage.getVramClassEvidenceHistory(nodeId, profileA);
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("pass");
  });

  it("G7-3 — Challenge failure records FAIL evidence with reason", async () => {
    const nodeId = await createTestNode();
    const { attemptId } = await issueChallenge(nodeId, profileA);

    await scoreAndRecordEvidence(attemptId, false, "STAGE_DEADLINE_MISSED");

    const history = await storage.getVramClassEvidenceHistory(nodeId, profileA);
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("fail");
    expect(history[0].failureReason).toBe("STAGE_DEADLINE_MISSED");
  });

  it("G7-4 — OOM evidence revokes certification", async () => {
    const nodeId = await createTestNode();

    // PASS first
    const { attemptId: passId, bundles } = await issueChallenge(nodeId, profileA);
    await passAllStages(passId, bundles);
    await scoreAndRecordEvidence(passId, true);

    let cert = await storage.getVramClassCertification(nodeId, profileA);
    expect(cert.state).toBe("certified");

    // OOM revokes
    const { attemptId: oomId } = await issueChallenge(nodeId, profileA);
    await scoreAndRecordEvidence(oomId, false, "VRAM_OOM");

    cert = await storage.getVramClassCertification(nodeId, profileA);
    expect(cert.state).toBe("revoked");
    expect(cert.revokingObservation?.failureReason).toBe("VRAM_OOM");
  });

  it("G7-5 — Cross-profile independence: A REVOKED, B CERTIFIED", async () => {
    const nodeId = await createTestNode();

    // PASS on B
    const { attemptId: bPass, bundles: bBundles } = await issueChallenge(nodeId, profileB);
    await passAllStages(bPass, bBundles);
    await scoreAndRecordEvidence(bPass, true);

    // PASS then OOM on A
    const { attemptId: aPass, bundles: aBundles } = await issueChallenge(nodeId, profileA);
    await passAllStages(aPass, aBundles);
    await scoreAndRecordEvidence(aPass, true);

    const { attemptId: aOom } = await issueChallenge(nodeId, profileA);
    await scoreAndRecordEvidence(aOom, false, "VRAM_OOM");

    const certA = await storage.getVramClassCertification(nodeId, profileA);
    expect(certA.state).toBe("revoked");

    const certB = await storage.getVramClassCertification(nodeId, profileB);
    expect(certB.state).toBe("certified");
  });
});
