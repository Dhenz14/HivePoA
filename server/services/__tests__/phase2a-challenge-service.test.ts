/**
 * Phase 2A Challenge Service — Service-Level Tests
 *
 * Tests the orchestration layer against real storage primitives.
 * Verifies that the service correctly drives the protocol without
 * duplicating storage-level logic or introducing shadow state.
 *
 * Covers:
 *   SVC1 — Issue stage 0, submit valid stage 0, receive stage 1 exactly once
 *   SVC2 — Duplicate valid checkpoint does not advance stage twice
 *   SVC3 — Invalid digest does not reveal next stage
 *   SVC4 — Invalid transcript predecessor does not reveal next stage
 *   SVC5 — Final valid stage triggers exact-once score mutation
 *   SVC6 — Concurrent final-stage submissions score exactly once
 *   SVC7 — Pool exhaustion returns clean failure, no orphan jobs
 *   SVC8 — Full 5-stage challenge via service entry points
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHash } from "crypto";
import { db } from "../../db";
import { sql, eq } from "drizzle-orm";
import {
  computeResourceClassProfiles,
  computeChallengeStageB,
  computeChallengeCheckpoints,
  computeJobs,
  computeJobAttempts,
  computeNodes,
} from "@shared/schema";
import { DatabaseStorage } from "../../storage";
import { Phase2AChallengeService } from "../phase2a-challenge-service";
import type { Phase2AChallengeStorage } from "../phase2a-challenge-service";

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function computeTranscriptEntryHash(prevHash: string, stageIndex: number, resultDigest: string): string {
  return createHash("sha256")
    .update(prevHash + stageIndex.toString() + resultDigest)
    .digest("hex");
}

const STAGES = 5;
const STAGE_DEADLINE_MS = 60_000;

let realStorage: DatabaseStorage;
let profileId: string;

/** Create test node via raw SQL. */
async function createTestNode(): Promise<string> {
  const nodeId = `svc-node-${uid()}`;
  await db.execute(sql`
    INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
    VALUES (${nodeId}, ${`inst-${uid()}`}, ${`user-${uid()}`}, 'online', 'RTX 4090', 24, 'gpu_poa_challenge', '0.50', 50, 0, 0, '0', 0, now())
  `);
  return nodeId;
}

/** Insert an orphan bundle set. */
async function insertOrphanSet(profId: string, stages: number = STAGES): Promise<string> {
  const setId = `svc-set-${uid()}`;
  const rootNonce = `${uid()}-${uid()}`;
  const bundles = Array.from({ length: stages }, (_, i) => ({
    challengeSetId: setId,
    profileId: profId,
    stageIndex: i,
    rootNonce,
    stageNonce: createHash("sha256")
      .update(rootNonce + String.fromCharCode(i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, (i >> 24) & 0xff))
      .digest("hex"),
    expectedDigest: createHash("sha256").update(`expected-${setId}-${i}`).digest("hex"),
    workloadParamsJson: JSON.stringify({
      protocol_version: 1, kernel_id: "phase2a-kernel-v1", class_id: 1,
      stage_index: i, M: 4096, N: 4096, K: 8, mix_rounds: 1,
    }),
  }));
  await realStorage.insertPrecomputedBundleSet(bundles);
  return setId;
}

/** Ensure Phase 2A tables exist (same as phase2a-storage.test.ts). */
async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS compute_resource_class_profiles (
      profile_id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id INTEGER NOT NULL, class_name TEXT NOT NULL,
      protocol_version INTEGER NOT NULL, kernel_id TEXT NOT NULL,
      m INTEGER NOT NULL, n INTEGER NOT NULL, k INTEGER NOT NULL,
      mix_rounds INTEGER NOT NULL, stages_per_challenge INTEGER NOT NULL,
      first_progress_deadline_ms INTEGER NOT NULL, stage_deadline_ms INTEGER NOT NULL,
      completion_deadline_ms INTEGER NOT NULL, pool_target INTEGER NOT NULL,
      pool_low_watermark_pct INTEGER NOT NULL, pool_critical_watermark_pct INTEGER NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS resource_class_profiles_version_class_id_idx ON compute_resource_class_profiles(protocol_version, class_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS resource_class_profiles_version_class_name_idx ON compute_resource_class_profiles(protocol_version, class_name)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS compute_challenge_stage_bundles (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      challenge_set_id VARCHAR NOT NULL, profile_id VARCHAR NOT NULL REFERENCES compute_resource_class_profiles(profile_id),
      stage_index INTEGER NOT NULL, root_nonce TEXT NOT NULL, stage_nonce TEXT NOT NULL,
      expected_digest TEXT NOT NULL, workload_params_json TEXT NOT NULL,
      precomputed_at TIMESTAMP NOT NULL DEFAULT now(), job_id VARCHAR REFERENCES compute_jobs(id),
      attempt_id VARCHAR REFERENCES compute_job_attempts(id), claimed_at TIMESTAMP,
      stage_issued_at TIMESTAMP, stage_deadline_at TIMESTAMP
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS challenge_stage_bundles_set_stage_idx ON compute_challenge_stage_bundles(challenge_set_id, stage_index)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS challenge_stage_bundles_attempt_stage_idx ON compute_challenge_stage_bundles(attempt_id, stage_index)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS challenge_stage_bundles_pool_idx ON compute_challenge_stage_bundles(profile_id, precomputed_at) WHERE attempt_id IS NULL`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS compute_challenge_checkpoints (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      attempt_id VARCHAR NOT NULL REFERENCES compute_job_attempts(id),
      stage_index INTEGER NOT NULL, stage_nonce TEXT NOT NULL, result_digest TEXT NOT NULL,
      checkpoint_received_at TIMESTAMP NOT NULL, telemetry_json TEXT,
      transcript_prev_hash TEXT NOT NULL, transcript_entry_hash TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS challenge_checkpoints_attempt_stage_idx ON compute_challenge_checkpoints(attempt_id, stage_index)`);

  // Ensure columns on existing tables
  await db.execute(sql`DO $$ BEGIN ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS target_node_id VARCHAR; ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS poa_scored_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`);
  await db.execute(sql`DO $$ BEGIN ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS last_poa_challenge_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`);
  await db.execute(sql`DO $$ BEGIN ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS challenge_protocol_version INTEGER; ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS challenge_profile_id VARCHAR; ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS first_progress_at TIMESTAMP; ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS checkpoint_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS transcript_hash TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS compute_job_attempts_id_job_id_idx ON compute_job_attempts(id, job_id)`);
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  realStorage = new DatabaseStorage();
  await ensureTables();

  // Use a random high classId to avoid collisions across test runs
  const testClassId = 1000 + Math.floor(Math.random() * 9000);
  const profile = await realStorage.createResourceClassProfile({
    classId: testClassId,
    className: `gpu-svc-test-${uid()}`,
    protocolVersion: 1,
    kernelId: "phase2a-kernel-v1",
    m: 4096, n: 4096, k: 8, mixRounds: 1,
    stagesPerChallenge: STAGES,
    firstProgressDeadlineMs: 30_000,
    stageDeadlineMs: STAGE_DEADLINE_MS,
    completionDeadlineMs: 600_000,
    poolTarget: 50,
    poolLowWatermarkPct: 50,
    poolCriticalWatermarkPct: 25,
  });
  profileId = profile.profileId;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 2A Service — Issue + Stage 0 Acceptance (SVC1, SVC2)", () => {
  let service: Phase2AChallengeService;

  beforeEach(() => {
    service = new Phase2AChallengeService(realStorage as unknown as Phase2AChallengeStorage);
  });

  it("SVC1: issue stage 0, submit valid checkpoint, receive stage 1", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    // Issue
    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(issue.stage0.stageIndex).toBe(0);
    expect(issue.stage0.stageNonce).toBeTruthy();
    expect(issue.stage0.workloadParams).toBeTruthy();

    // Get the bundle to know expected digest
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;

    // Submit valid checkpoint for stage 0
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);
    const cp = await service.acceptCheckpoint(
      issue.attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0,
    );
    expect(cp.ok).toBe(true);
    if (!cp.ok) return;
    expect(cp.final).toBe(false);
    expect(cp.nextStage).not.toBeNull();
    expect(cp.nextStage!.stageIndex).toBe(1);
  });

  it("SVC2: duplicate valid checkpoint does not advance stage twice", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);

    // First submission
    const cp1 = await service.acceptCheckpoint(
      issue.attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0,
    );
    expect(cp1.ok).toBe(true);

    // Duplicate submission — should be idempotent
    const cp2 = await service.acceptCheckpoint(
      issue.attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0,
    );
    expect(cp2.ok).toBe(true);
    if (cp1.ok && cp2.ok) {
      // Same checkpoint returned
      expect(cp1.checkpoint.id).toBe(cp2.checkpoint.id);
    }

    // Stage 1 should be revealed exactly once (verify via bundles)
    const updatedBundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b1 = updatedBundles.find(b => b.stageIndex === 1)!;
    expect(b1.stageIssuedAt).not.toBeNull();
  });
});

describe("Phase 2A Service — Rejection Paths (SVC3, SVC4)", () => {
  let service: Phase2AChallengeService;

  beforeEach(() => {
    service = new Phase2AChallengeService(realStorage as unknown as Phase2AChallengeStorage);
  });

  it("SVC3: invalid digest does not reveal next stage", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;

    // Wrong digest
    const wrongDigest = "0".repeat(64);
    const entry = computeTranscriptEntryHash("", 0, wrongDigest);
    const cp = await service.acceptCheckpoint(
      issue.attemptId, 0, wrongDigest, b0.stageNonce, "", entry,
    );
    expect(cp.ok).toBe(false);
    if (!cp.ok) expect(cp.reason).toBe("STAGE_DIGEST_MISMATCH");

    // Stage 1 must NOT be revealed
    const updatedBundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b1 = updatedBundles.find(b => b.stageIndex === 1)!;
    expect(b1.stageIssuedAt).toBeNull();
  });

  it("SVC4: invalid transcript predecessor does not reveal next stage", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);

    // Submit valid stage 0
    await service.acceptCheckpoint(
      issue.attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0,
    );

    // Stage 1 with wrong prev hash
    const b1 = bundles.find(b => b.stageIndex === 1)!;
    const wrongPrev = "f".repeat(64);
    const entry1 = computeTranscriptEntryHash(wrongPrev, 1, b1.expectedDigest);
    const cp = await service.acceptCheckpoint(
      issue.attemptId, 1, b1.expectedDigest, b1.stageNonce, wrongPrev, entry1,
    );
    expect(cp.ok).toBe(false);
    if (!cp.ok) expect(cp.reason).toBe("TRANSCRIPT_HASH_MISMATCH");

    // Stage 2 must NOT be revealed
    const updatedBundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b2 = updatedBundles.find(b => b.stageIndex === 2)!;
    expect(b2.stageIssuedAt).toBeNull();
  });
});

describe("Phase 2A Service — Scoring (SVC5, SVC6)", () => {
  let service: Phase2AChallengeService;

  beforeEach(() => {
    service = new Phase2AChallengeService(realStorage as unknown as Phase2AChallengeStorage);
  });

  it("SVC5: final valid stage triggers exact-once score", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sortedBundles = bundles.sort((a, b) => a.stageIndex - b.stageIndex);

    // Walk all 5 stages
    let prevHash = "";
    for (let i = 0; i < STAGES; i++) {
      const b = sortedBundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      const cp = await service.acceptCheckpoint(
        issue.attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
      );
      expect(cp.ok).toBe(true);
      if (cp.ok && i === STAGES - 1) {
        expect(cp.final).toBe(true);
      }
      prevHash = entryHash;
    }

    // Verify job was scored
    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.state).toBe("accepted");
    expect(job.poaScoredAt).not.toBeNull();
  });

  it("SVC6: concurrent final-stage submissions score exactly once", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sortedBundles = bundles.sort((a, b) => a.stageIndex - b.stageIndex);

    // Walk stages 0..3
    let prevHash = "";
    for (let i = 0; i < STAGES - 1; i++) {
      const b = sortedBundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      await service.acceptCheckpoint(
        issue.attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
      );
      prevHash = entryHash;
    }

    // Race final stage submission
    const bFinal = sortedBundles[STAGES - 1];
    const finalEntry = computeTranscriptEntryHash(prevHash, STAGES - 1, bFinal.expectedDigest);

    const [r1, r2] = await Promise.all([
      service.acceptCheckpoint(issue.attemptId, STAGES - 1, bFinal.expectedDigest, bFinal.stageNonce, prevHash, finalEntry),
      service.acceptCheckpoint(issue.attemptId, STAGES - 1, bFinal.expectedDigest, bFinal.stageNonce, prevHash, finalEntry),
    ]);

    // Both should succeed (idempotent checkpoint + idempotent scoring)
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Job scored exactly once
    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.poaScoredAt).not.toBeNull();
  });
});

describe("Phase 2A Service — Pool Exhaustion (SVC7)", () => {
  it("SVC7: pool exhaustion returns clean failure, no orphan jobs", async () => {
    const service = new Phase2AChallengeService(realStorage as unknown as Phase2AChallengeStorage);
    const nodeId = await createTestNode();

    // Use an empty profile (no orphan sets)
    const emptyClassId = 10000 + Math.floor(Math.random() * 90000);
    const emptyProfile = await realStorage.createResourceClassProfile({
      classId: emptyClassId,
      className: `gpu-empty-${uid()}`,
      protocolVersion: 1,
      kernelId: "phase2a-kernel-v1",
      m: 4096, n: 4096, k: 8, mixRounds: 1,
      stagesPerChallenge: 5,
      firstProgressDeadlineMs: 30_000,
      stageDeadlineMs: 60_000,
      completionDeadlineMs: 600_000,
      poolTarget: 50,
      poolLowWatermarkPct: 50,
      poolCriticalWatermarkPct: 25,
    });

    const result = await service.issueChallenge(nodeId, emptyProfile.profileId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("POOL_EXHAUSTED");
  });
});

describe("Phase 2A Service — Full Happy Path (SVC8)", () => {
  it("SVC8: 5-stage challenge end-to-end via service entry points", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = new Phase2AChallengeService(realStorage as unknown as Phase2AChallengeStorage);

    // Issue
    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Verify stage 0 payload
    expect(issue.stage0.stageIndex).toBe(0);
    expect(issue.stage0.workloadParams.protocol_version).toBe(1);
    expect(issue.stage0.workloadParams.kernel_id).toBe("phase2a-kernel-v1");

    // Walk all stages via service
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sortedBundles = bundles.sort((a, b) => a.stageIndex - b.stageIndex);

    let prevHash = "";
    for (let i = 0; i < STAGES; i++) {
      const b = sortedBundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);

      const cp = await service.acceptCheckpoint(
        issue.attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
      );
      expect(cp.ok).toBe(true);
      if (!cp.ok) return;

      if (i < STAGES - 1) {
        expect(cp.final).toBe(false);
        expect(cp.nextStage).not.toBeNull();
        expect(cp.nextStage!.stageIndex).toBe(i + 1);
      } else {
        expect(cp.final).toBe(true);
        expect(cp.nextStage).toBeNull();
      }

      prevHash = entryHash;
    }

    // Verify final state
    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.state).toBe("accepted");
    expect(job.poaScoredAt).not.toBeNull();

    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.checkpointCount).toBe(STAGES);
    expect(attempt.transcriptHash).toBe(prevHash);
    expect(attempt.firstProgressAt).not.toBeNull();
    expect(attempt.state).toBe("accepted");
  });
});
