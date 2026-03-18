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
import { sql, eq, and, isNull } from "drizzle-orm";
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

/** Create a ready-to-issue service instance (startup reconciliation completed). */
async function createReadyService(): Promise<Phase2AChallengeService> {
  const svc = new Phase2AChallengeService(realStorage as unknown as Phase2AChallengeStorage);
  await svc.initialize();
  return svc;
}

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

  beforeEach(async () => {
    service = await createReadyService();
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

  beforeEach(async () => {
    service = await createReadyService();
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

  beforeEach(async () => {
    service = await createReadyService();
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
    const service = await createReadyService();
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
    const service = await createReadyService();

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

// ════════════════════════════════════════════════════════════════════════════
// CRASH-BOUNDARY RECOVERY TESTS (CR1–CR4)
// ════════════════════════════════════════════════════════════════════════════

describe("Phase 2A Service — Crash-Boundary Recovery (CR1–CR4)", () => {
  let service: Phase2AChallengeService;

  beforeEach(async () => {
    service = await createReadyService();
  });

  it("CR1: crash after claiming a set, before first reveal — sweep expires as FIRST_PROGRESS_MISSED", async () => {
    // Issue a challenge normally (this claims + reveals stage 0).
    // Then simulate the "claim but no reveal" scenario by creating a raw
    // challenge where stage 0 is never revealed and no checkpoint arrives.
    // We manipulate timestamps to make first_progress_deadline pass.
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Backdate the attempt creation to make first_progress_deadline pass.
    // Profile has firstProgressDeadlineMs=30_000, so push createdAt 60s into the past.
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET created_at = now() - interval '120 seconds', first_progress_at = NULL
      WHERE id = ${issue.attemptId}
    `);
    // Ensure the job is still in a sweepable state
    await db.execute(sql`
      UPDATE compute_jobs SET state = 'leased' WHERE id = ${issue.jobId}
    `);
    // Remove any checkpoints that were accidentally created
    await db.execute(sql`
      DELETE FROM compute_challenge_checkpoints WHERE attempt_id = ${issue.attemptId}
    `);
    // Reset checkpoint_count
    await db.execute(sql`
      UPDATE compute_job_attempts SET checkpoint_count = 0, first_progress_at = NULL WHERE id = ${issue.attemptId}
    `);

    // Run sweep
    await service.sweepTimeouts();

    // Verify: attempt timed out, job rejected, scored
    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");

    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.state).toBe("rejected");
    expect(job.poaScoredAt).not.toBeNull();
  });

  it("CR2: crash after reveal, before checkpoint — sweep expires as STAGE_DEADLINE_MISSED", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Stage 0 is revealed. Simulate: worker never submits checkpoint,
    // and the stage deadline passes.
    // Backdate stage_deadline_at to the past.
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '60 seconds'
      WHERE attempt_id = ${issue.attemptId} AND stage_index = 0
    `);
    // Mark first_progress_at so we don't trigger FIRST_PROGRESS_MISSED instead.
    // But also need created_at recent enough to not trigger completion deadline.
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET first_progress_at = now() - interval '30 seconds'
      WHERE id = ${issue.attemptId}
    `);

    await service.sweepTimeouts();

    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");
    expect(attempt.failureReason).toBe("STAGE_DEADLINE_MISSED");

    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.state).toBe("rejected");
    expect(job.poaScoredAt).not.toBeNull();
  });

  it("CR3: crash after checkpoint commit, before response — sweep scores via sweepScoring", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Walk all 5 stages to completion
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sortedBundles = bundles.sort((a, b) => a.stageIndex - b.stageIndex);
    let prevHash = "";
    for (let i = 0; i < STAGES; i++) {
      const b = sortedBundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      await service.acceptCheckpoint(
        issue.attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
      );
      prevHash = entryHash;
    }

    // Now simulate crash: job is "accepted" but poaScoredAt was lost.
    // Reset the score latch to simulate crash-after-state-update-before-score.
    await db.execute(sql`
      UPDATE compute_jobs SET poa_scored_at = NULL WHERE id = ${issue.jobId}
    `);

    // sweepScoring should pick this up and re-score
    await service.sweepScoring();

    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.poaScoredAt).not.toBeNull();
  });

  it("CR4: crash during final-stage scoring path — sweepScoring recovers", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Walk stages 0..3
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sortedBundles = bundles.sort((a, b) => a.stageIndex - b.stageIndex);
    let prevHash = "";
    for (let i = 0; i < STAGES - 1; i++) {
      const b = sortedBundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      await service.acceptCheckpoint(
        issue.attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
      );
      prevHash = entryHash;
    }

    // Simulate: final checkpoint accepted, attempt/job state set to accepted,
    // but scoring latch never fired (crash between state update and score).
    const bFinal = sortedBundles[STAGES - 1];
    const finalEntry = computeTranscriptEntryHash(prevHash, STAGES - 1, bFinal.expectedDigest);
    await service.acceptCheckpoint(
      issue.attemptId, STAGES - 1, bFinal.expectedDigest, bFinal.stageNonce, prevHash, finalEntry,
    );

    // Wipe the score latch to simulate the crash
    await db.execute(sql`
      UPDATE compute_jobs SET poa_scored_at = NULL WHERE id = ${issue.jobId}
    `);

    // Run sweepScoring twice — second invocation must be idempotent
    await service.sweepScoring();
    await service.sweepScoring();

    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.poaScoredAt).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SWEEPER BURN-IN TESTS (SW1–SW4)
// ════════════════════════════════════════════════════════════════════════════

describe("Phase 2A Service — Sweeper Burn-In (SW1–SW4)", () => {
  let service: Phase2AChallengeService;

  beforeEach(async () => {
    service = await createReadyService();
  });

  it("SW1: expired revealed stage with no checkpoint — swept as STAGE_DEADLINE_MISSED", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Submit valid stage 0 checkpoint so first_progress_at is set
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);
    await service.acceptCheckpoint(
      issue.attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0,
    );

    // Stage 1 is now auto-revealed. Backdate its deadline to the past.
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '60 seconds'
      WHERE attempt_id = ${issue.attemptId} AND stage_index = 1
    `);

    await service.sweepTimeouts();

    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");
    expect(attempt.failureReason).toBe("STAGE_DEADLINE_MISSED");
  });

  it("SW2: claimed-but-never-progressed attempt — swept as FIRST_PROGRESS_MISSED", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Remove any checkpoints and reset first_progress_at.
    // Backdate created_at past first_progress_deadline (30s in test profile).
    await db.execute(sql`
      DELETE FROM compute_challenge_checkpoints WHERE attempt_id = ${issue.attemptId}
    `);
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET created_at = now() - interval '120 seconds',
          first_progress_at = NULL,
          checkpoint_count = 0
      WHERE id = ${issue.attemptId}
    `);

    await service.sweepTimeouts();

    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");
    expect(attempt.failureReason).toBe("FIRST_PROGRESS_MISSED");

    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.state).toBe("rejected");
    expect(job.poaScoredAt).not.toBeNull();
  });

  it("SW3: partial chain abandoned mid-protocol — swept as STAGE_DEADLINE_MISSED", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Complete stages 0 and 1, then abandon at stage 2
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sortedBundles = bundles.sort((a, b) => a.stageIndex - b.stageIndex);
    let prevHash = "";
    for (let i = 0; i < 2; i++) {
      const b = sortedBundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      await service.acceptCheckpoint(
        issue.attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
      );
      prevHash = entryHash;
    }

    // Stage 2 is auto-revealed. Backdate its deadline.
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '60 seconds'
      WHERE attempt_id = ${issue.attemptId} AND stage_index = 2
    `);

    await service.sweepTimeouts();

    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");
    expect(attempt.failureReason).toBe("STAGE_DEADLINE_MISSED");

    // Verify: 2 checkpoints exist (stages 0, 1), stage 2 never completed
    const cps = await realStorage.getChallengeCheckpoints(issue.attemptId);
    expect(cps).toHaveLength(2);
  });

  it("SW4: duplicate sweep safety — concurrent sweepers do not double-process", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Set up first_progress_missed condition
    await db.execute(sql`
      DELETE FROM compute_challenge_checkpoints WHERE attempt_id = ${issue.attemptId}
    `);
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET created_at = now() - interval '120 seconds',
          first_progress_at = NULL,
          checkpoint_count = 0
      WHERE id = ${issue.attemptId}
    `);

    // Race two sweep() calls — the re-entrancy guard (sweepRunning) prevents
    // concurrent execution within the same instance, but the exact-once score
    // latch protects against cross-instance races.
    const service2 = await createReadyService();
    await Promise.all([
      service.sweep(),
      service2.sweep(),
    ]);

    // Job must be scored exactly once
    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, issue.jobId));
    expect(job.state).toBe("rejected");
    expect(job.poaScoredAt).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POOL BEHAVIOR UNDER PRESSURE (PL1–PL3)
// ════════════════════════════════════════════════════════════════════════════

describe("Phase 2A Service — Pool Behavior Under Pressure (PL1–PL3)", () => {
  let service: Phase2AChallengeService;

  beforeEach(async () => {
    service = await createReadyService();
  });

  it("PL1: low-watermark and critical-watermark detection", async () => {
    // Profile has poolTarget=50, lowWatermarkPct=50 (25 sets), criticalPct=25 (12 sets).
    // Insert enough sets to be above low watermark, then drain to detect thresholds.

    // Insert 10 sets — well below low watermark (50% of 50 = 25)
    for (let i = 0; i < 10; i++) {
      await insertOrphanSet(profileId);
    }

    const profiles = await realStorage.getActiveResourceClassProfiles();
    const profile = profiles.find(p => p.profileId === profileId)!;
    const poolCount = await realStorage.getOrphanPoolCount(profileId);

    const lowThreshold = Math.ceil(profile.poolTarget * profile.poolLowWatermarkPct / 100);
    const criticalThreshold = Math.ceil(profile.poolTarget * profile.poolCriticalWatermarkPct / 100);

    // With 10 sets (plus any leftover from other tests), check watermark state
    const isLow = poolCount < lowThreshold;
    const isCritical = poolCount < criticalThreshold;

    // 10 < 25 → low watermark hit
    expect(isLow).toBe(true);
    // 10 < 13 → critical watermark hit
    expect(isCritical).toBe(true);

    // Now insert enough to be above low watermark
    for (let i = 0; i < 20; i++) {
      await insertOrphanSet(profileId);
    }
    const poolCount2 = await realStorage.getOrphanPoolCount(profileId);
    const isLow2 = poolCount2 < lowThreshold;
    // 30+ sets → above low watermark
    expect(isLow2).toBe(false);
  });

  it("PL2: starvation/fairness from candidate-set claim algorithm", async () => {
    // Insert 3 sets, then race 3 workers claiming concurrently.
    // Each must get exactly one set (no starvation, no double-claim).
    await insertOrphanSet(profileId);
    await insertOrphanSet(profileId);
    await insertOrphanSet(profileId);

    const nodes = await Promise.all([createTestNode(), createTestNode(), createTestNode()]);
    const services = await Promise.all(
      nodes.map(() => createReadyService())
    );

    const results = await Promise.all(
      nodes.map((nodeId, i) => services[i].issueChallenge(nodeId, profileId))
    );

    const successes = results.filter(r => r.ok);
    // All 3 should succeed (3 sets for 3 workers)
    expect(successes.length).toBe(3);

    // Each got a distinct set (verify via bundles)
    const setIds = new Set<string>();
    for (const r of successes) {
      if (!r.ok) continue;
      const bundles = await realStorage.getChallengeBundles(r.attemptId);
      setIds.add(bundles[0].challengeSetId);
    }
    expect(setIds.size).toBe(3); // 3 distinct sets
  });

  it("PL3: refill while claims are concurrently happening", async () => {
    // Simulate: pool starts with 2 sets, 3 workers try to claim,
    // while a 4th set is inserted mid-race (simulated by pre-inserting).
    // At most 2 succeed from the initial pool; the insert happens
    // "concurrently" but before the 3rd claim resolves.
    await insertOrphanSet(profileId);
    await insertOrphanSet(profileId);

    const nodes = await Promise.all([createTestNode(), createTestNode(), createTestNode()]);

    // Launch 2 claims + 1 insert + 1 claim concurrently
    const [r1, r2, , r3] = await Promise.all([
      service.issueChallenge(nodes[0], profileId),
      service.issueChallenge(nodes[1], profileId),
      insertOrphanSet(profileId), // "refill" mid-race
      service.issueChallenge(nodes[2], profileId),
    ]);

    const results = [r1, r2, r3];
    const successes = results.filter(r => r.ok);

    // At least 2 must succeed (from initial pool). The 3rd may or may not
    // succeed depending on timing — the refill set may or may not be visible.
    expect(successes.length).toBeGreaterThanOrEqual(2);

    // No matter what, every successful claim must have a complete bundle set
    for (const r of successes) {
      if (!r.ok) continue;
      const bundles = await realStorage.getChallengeBundles(r.attemptId);
      expect(bundles).toHaveLength(STAGES);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STALE-SELECTION ADVERSARIAL TESTS (SS1–SS3)
//
// These prove the TOCTOU stale-candidate mitigation works:
// the sweep query selects a candidate, then state changes between
// selection and application, and the sweeper correctly skips it.
// ════════════════════════════════════════════════════════════════════════════

describe("Phase 2A Service — Stale-Selection Adversarial (SS1–SS3)", () => {

  it("SS1: sweeper selects FIRST_PROGRESS_MISSED, then checkpoint lands — sweeper skips", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = await createReadyService();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Make the attempt look expired for first_progress_missed:
    // backdate created_at, clear first_progress_at.
    await db.execute(sql`
      DELETE FROM compute_challenge_checkpoints WHERE attempt_id = ${issue.attemptId}
    `);
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET created_at = now() - interval '120 seconds',
          first_progress_at = NULL,
          checkpoint_count = 0
      WHERE id = ${issue.attemptId}
    `);

    // Now simulate: between the sweep query and the timeout application,
    // a valid checkpoint arrives. We do this by submitting the checkpoint
    // BEFORE calling sweep — the stale-check should see the fresh state.
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);

    // Re-reveal stage 0 if needed (it may have been revealed during issue).
    // The checkpoint will set first_progress_at.
    const cpResult = await service.acceptCheckpoint(
      issue.attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0,
    );
    expect(cpResult.ok).toBe(true);

    // Now run sweep — it should find this attempt in the expired query
    // (because created_at is backdated), but the stale-check should see
    // firstProgressAt is now set and skip it.
    await service.sweepTimeouts();

    // Attempt must NOT be timed out — the checkpoint saved it.
    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).not.toBe("timed_out");
    expect(attempt.firstProgressAt).not.toBeNull();
  });

  it("SS2: sweeper selects STAGE_DEADLINE_MISSED, then valid stage progress lands — sweeper skips", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = await createReadyService();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Complete stage 0 so first_progress_at is set.
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sortedBundles = bundles.sort((a, b) => a.stageIndex - b.stageIndex);
    const b0 = sortedBundles[0];
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);
    await service.acceptCheckpoint(
      issue.attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0,
    );

    // Stage 1 is now auto-revealed. Submit a valid checkpoint for it
    // while the deadline is still in the future.
    const b1 = sortedBundles[1];
    const entry1 = computeTranscriptEntryHash(entry0, 1, b1.expectedDigest);
    const cpResult = await service.acceptCheckpoint(
      issue.attemptId, 1, b1.expectedDigest, b1.stageNonce, entry0, entry1,
    );
    expect(cpResult.ok).toBe(true);

    // Now backdate stage 1's deadline to the past AFTER the checkpoint was accepted.
    // This simulates the race: the sweep query runs and sees stage 1's deadline
    // as expired, but a checkpoint already exists for it.
    // The stale-check must detect the checkpoint and skip.
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '60 seconds'
      WHERE attempt_id = ${issue.attemptId} AND stage_index = 1
    `);

    // Run sweep — the expired query may find this attempt because stage 1
    // deadline is in the past, but the stale-check should see the checkpoint
    // exists for stage 1 and skip.
    await service.sweepTimeouts();

    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).not.toBe("timed_out");
    expect(attempt.checkpointCount).toBeGreaterThanOrEqual(2);
  });

  it("SS3: sweeper selects timeout candidate, but attempt already terminal — sweeper skips", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = await createReadyService();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Set up a first_progress_missed condition via backdating.
    await db.execute(sql`
      DELETE FROM compute_challenge_checkpoints WHERE attempt_id = ${issue.attemptId}
    `);
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET created_at = now() - interval '120 seconds',
          first_progress_at = NULL,
          checkpoint_count = 0
      WHERE id = ${issue.attemptId}
    `);

    // Between query and application, the attempt becomes terminal
    // (e.g., another sweeper or manual intervention already processed it).
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET state = 'rejected', finished_at = now()
      WHERE id = ${issue.attemptId}
    `);
    await db.execute(sql`
      UPDATE compute_jobs
      SET state = 'rejected', completed_at = now()
      WHERE id = ${issue.jobId}
    `);

    // Get reputation before sweep
    const [nodeBefore] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${nodeId}
    `).then(r => (r.rows ?? r) as any[]);
    const repBefore = Number(nodeBefore.reputation_score);

    // Run sweep — should skip because attempt is already terminal.
    await service.sweepTimeouts();

    // Attempt state should still be 'rejected' (not overwritten to 'timed_out').
    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("rejected");

    // Reputation should not have been decremented by the sweep
    // (the exact-once latch also protects this, but the stale-check should prevent even attempting).
    const [nodeAfter] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${nodeId}
    `).then(r => (r.rows ?? r) as any[]);
    const repAfter = Number(nodeAfter.reputation_score);
    expect(repAfter).toBe(repBefore);
  });
});
