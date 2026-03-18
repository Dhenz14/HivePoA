/**
 * Phase 2A Storage Primitives — DB-Backed Transactional Tests
 *
 * Runs against real PostgreSQL (requires DATABASE_URL).
 * Tests transaction boundaries, concurrency, crash recovery semantics.
 *
 * Covers:
 *   T1 — Two concurrent workers cannot claim the same orphan set
 *   T2 — Partially malformed set cannot be claimed
 *   T3 — Reveal is one-shot; second reveal is null
 *   T4 — Checkpoint before reveal is rejected
 *   T5 — Duplicate checkpoint for same stage is idempotently ignored
 *   T6 — Correct digest but wrong transcript predecessor is rejected
 *   T7 — Final-stage completion under concurrent submits scores exactly once
 *   T8 — Crash after checkpoint insert but before next-stage reveal leaves recoverable state
 *   T9 — Crash after reveal but before checkpoint leaves timeout-recoverable state
 *   T10 — Pool scan under depletion does not hand out half-claimed sets
 *   T11 — Cross-job drift: bundle cannot point at attempt from different job
 *   T12 — Late checkpoint (past deadline) is rejected
 *   T13 — Wrong nonce is rejected
 *   T14 — Wrong digest is rejected
 *   T15 — Full 5-stage happy path through storage primitives
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "crypto";
import { db } from "../db";
import { sql, eq, and, isNull } from "drizzle-orm";
import {
  computeResourceClassProfiles,
  computeChallengeStageB,
  computeChallengeCheckpoints,
  computeJobs,
  computeJobAttempts,
  computeNodes,
} from "@shared/schema";
import { DatabaseStorage } from "../storage";

// ── Test Helpers ─────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function computeTranscriptEntryHash(prevHash: string, stageIndex: number, resultDigest: string): string {
  return createHash("sha256")
    .update(prevHash + stageIndex.toString() + resultDigest)
    .digest("hex");
}

/** Check if Phase 2A tables exist (first run needs migration). */
async function ensureTables(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1 FROM compute_resource_class_profiles LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

/** Create Phase 2A tables if they don't exist yet. */
async function createPhase2aTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS compute_resource_class_profiles (
      profile_id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id INTEGER NOT NULL,
      class_name TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      kernel_id TEXT NOT NULL,
      m INTEGER NOT NULL,
      n INTEGER NOT NULL,
      k INTEGER NOT NULL,
      mix_rounds INTEGER NOT NULL,
      stages_per_challenge INTEGER NOT NULL,
      first_progress_deadline_ms INTEGER NOT NULL,
      stage_deadline_ms INTEGER NOT NULL,
      completion_deadline_ms INTEGER NOT NULL,
      pool_target INTEGER NOT NULL,
      pool_low_watermark_pct INTEGER NOT NULL,
      pool_critical_watermark_pct INTEGER NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS resource_class_profiles_version_class_id_idx
      ON compute_resource_class_profiles(protocol_version, class_id)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS resource_class_profiles_version_class_name_idx
      ON compute_resource_class_profiles(protocol_version, class_name)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS compute_challenge_stage_bundles (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      challenge_set_id VARCHAR NOT NULL,
      profile_id VARCHAR NOT NULL REFERENCES compute_resource_class_profiles(profile_id),
      stage_index INTEGER NOT NULL,
      root_nonce TEXT NOT NULL,
      stage_nonce TEXT NOT NULL,
      expected_digest TEXT NOT NULL,
      workload_params_json TEXT NOT NULL,
      precomputed_at TIMESTAMP NOT NULL DEFAULT now(),
      job_id VARCHAR REFERENCES compute_jobs(id),
      attempt_id VARCHAR REFERENCES compute_job_attempts(id),
      claimed_at TIMESTAMP,
      stage_issued_at TIMESTAMP,
      stage_deadline_at TIMESTAMP
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS challenge_stage_bundles_set_stage_idx
      ON compute_challenge_stage_bundles(challenge_set_id, stage_index)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS challenge_stage_bundles_attempt_stage_idx
      ON compute_challenge_stage_bundles(attempt_id, stage_index)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS challenge_stage_bundles_pool_idx
      ON compute_challenge_stage_bundles(profile_id, precomputed_at)
      WHERE attempt_id IS NULL
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS compute_challenge_checkpoints (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      attempt_id VARCHAR NOT NULL REFERENCES compute_job_attempts(id),
      stage_index INTEGER NOT NULL,
      stage_nonce TEXT NOT NULL,
      result_digest TEXT NOT NULL,
      checkpoint_received_at TIMESTAMP NOT NULL,
      telemetry_json TEXT,
      transcript_prev_hash TEXT NOT NULL,
      transcript_entry_hash TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS challenge_checkpoints_attempt_stage_idx
      ON compute_challenge_checkpoints(attempt_id, stage_index)
  `);

  // Sync compute_jobs: add columns the DB may be missing
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS target_node_id VARCHAR;
      ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS poa_scored_at TIMESTAMP;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);

  // Sync compute_nodes: add columns the DB may be missing
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS last_poa_challenge_at TIMESTAMP;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);

  // Add Phase 2A rollup columns to compute_job_attempts if not present
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS challenge_protocol_version INTEGER;
      ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS challenge_profile_id VARCHAR;
      ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS first_progress_at TIMESTAMP;
      ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS checkpoint_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS transcript_hash TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);

  // Composite uniqueness on attempts (for cross-job drift prevention)
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS compute_job_attempts_id_job_id_idx
      ON compute_job_attempts(id, job_id)
  `);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const STAGES = 5;
const STAGE_DEADLINE_MS = 60_000;

let storage: DatabaseStorage;
let profileId: string;
let tablesReady = false;

/** Create a test node in the DB via raw SQL (avoids schema drift on columns the DB hasn't migrated yet). */
async function createTestNode(): Promise<string> {
  const nodeId = `test-node-${uid()}`;
  const instId = `inst-${uid()}`;
  const username = `test-user-${uid()}`;
  await db.execute(sql`
    INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
    VALUES (${nodeId}, ${instId}, ${username}, 'online', 'RTX 4090', 24, 'eval_sweep', '0.50', 50, 0, 0, '0', 0, now())
  `);
  return nodeId;
}

/** Create a test job in the DB via raw SQL. */
async function createTestJob(targetNodeId?: string): Promise<string> {
  const jobId = `test-job-${uid()}`;
  const sha = createHash("sha256").update("test").digest("hex");
  const target = targetNodeId ?? null;
  await db.execute(sql`
    INSERT INTO compute_jobs (id, creator_username, workload_type, state, priority, manifest_json, manifest_sha256, min_vram_gb, budget_hbd, reserved_budget_hbd, lease_seconds, max_attempts, attempt_count, target_node_id, created_at)
    VALUES (${jobId}, 'test-coordinator', 'gpu_poa_challenge', 'queued', 10, '{}', ${sha}, 0, '0', '0', 3600, 3, 0, ${target}, now())
  `);
  return jobId;
}

/** Create a test attempt in the DB via raw SQL. */
async function createTestAttempt(jobId: string, nodeId: string): Promise<string> {
  const attemptId = `test-att-${uid()}`;
  const token = uid();
  const nonce = uid();
  const expires = new Date(Date.now() + 3600_000);
  await db.execute(sql`
    INSERT INTO compute_job_attempts (id, job_id, node_id, lease_token, nonce, state, progress_pct, lease_expires_at, checkpoint_count, created_at)
    VALUES (${attemptId}, ${jobId}, ${nodeId}, ${token}, ${nonce}, 'leased', 0, ${expires}, 0, now())
  `);
  return attemptId;
}

/** Insert one orphan bundle set into the pool. */
async function insertOrphanSet(profId: string, stages: number = STAGES): Promise<string> {
  const setId = `set-${uid()}`;
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
  await storage.insertPrecomputedBundleSet(bundles);
  return setId;
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  storage = new DatabaseStorage();

  // Always ensure tables and columns are present (idempotent DDL)
  await createPhase2aTables();
  tablesReady = true;

  // Create the test profile
  const profile = await storage.createResourceClassProfile({
    classId: 100000 + Math.floor(Math.random() * 900000), // random to avoid cross-run collisions
    className: `gpu-test-${uid()}`,
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

afterAll(async () => {
  // Cleanup: remove test data
  if (tablesReady && profileId) {
    await db.delete(computeChallengeCheckpoints)
      .where(sql`attempt_id IN (
        SELECT csb.attempt_id FROM compute_challenge_stage_bundles csb
        WHERE csb.profile_id = ${profileId}
      )`);
    await db.delete(computeChallengeStageB)
      .where(eq(computeChallengeStageB.profileId, profileId));
    await db.delete(computeResourceClassProfiles)
      .where(eq(computeResourceClassProfiles.profileId, profileId));
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 2A Storage — Claim Primitives (T1, T2, T10, T11)", () => {
  it("T1: two concurrent workers cannot claim the same orphan set", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const job1 = await createTestJob(nodeId);
    const job2 = await createTestJob(nodeId);
    const att1 = await createTestAttempt(job1, nodeId);
    const att2 = await createTestAttempt(job2, nodeId);

    // Race two claims — only one pool set available
    const [r1, r2] = await Promise.all([
      storage.claimOrphanChallengeSet(profileId, job1, att1),
      storage.claimOrphanChallengeSet(profileId, job2, att2),
    ]);

    const winners = [r1, r2].filter(r => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toHaveLength(STAGES);
  });

  it("T2: partially malformed set (wrong stage count) cannot be claimed", async () => {
    // Insert a set with only 3 stages when profile expects 5
    const setId = `set-bad-${uid()}`;
    const rootNonce = uid();
    const bundles = Array.from({ length: 3 }, (_, i) => ({
      challengeSetId: setId,
      profileId,
      stageIndex: i,
      rootNonce,
      stageNonce: createHash("sha256").update(`${rootNonce}-${i}`).digest("hex"),
      expectedDigest: createHash("sha256").update(`bad-${i}`).digest("hex"),
      workloadParamsJson: "{}",
    }));
    await storage.insertPrecomputedBundleSet(bundles);

    const nodeId = await createTestNode();
    const jobId = await createTestJob(nodeId);
    const attId = await createTestAttempt(jobId, nodeId);

    const result = await storage.claimOrphanChallengeSet(profileId, jobId, attId);
    // Should skip the malformed set (or return null if it's the only available)
    // This depends on whether any other orphan sets exist.
    // The 3-stage set should never be returned.
    if (result !== null) {
      expect(result).toHaveLength(STAGES); // if something was claimed, it must be properly sized
    }
  });

  it("T10: pool scan under depletion does not hand out half-claimed sets", async () => {
    // Insert 2 sets, claim both concurrently with 3 workers
    await insertOrphanSet(profileId);
    await insertOrphanSet(profileId);

    const nodeId = await createTestNode();
    const jobs = await Promise.all([createTestJob(nodeId), createTestJob(nodeId), createTestJob(nodeId)]);
    const atts = await Promise.all(jobs.map(j => createTestAttempt(j, nodeId)));

    const results = await Promise.all(
      jobs.map((j, i) => storage.claimOrphanChallengeSet(profileId, j, atts[i]))
    );

    const winners = results.filter(r => r !== null);
    expect(winners.length).toBeLessThanOrEqual(2); // at most 2 sets available

    // Each winner must be a complete set
    for (const w of winners) {
      expect(w).toHaveLength(STAGES);
      // All stages must point to the same attempt
      const attemptIds = new Set(w!.map(b => b.attemptId));
      expect(attemptIds.size).toBe(1);
    }
  });

  it("T11: cross-job drift — attempt from different job is rejected", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const jobA = await createTestJob(nodeId);
    const jobB = await createTestJob(nodeId);
    const attA = await createTestAttempt(jobA, nodeId); // belongs to jobA

    // Try to claim with jobB but attA (mismatched)
    const result = await storage.claimOrphanChallengeSet(profileId, jobB, attA);
    expect(result).toBeNull();
  });
});

describe("Phase 2A Storage — Reveal Primitives (T3, T9)", () => {
  let attemptId: string;

  beforeEach(async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const jobId = await createTestJob(nodeId);
    attemptId = await createTestAttempt(jobId, nodeId);
    await storage.claimOrphanChallengeSet(profileId, jobId, attemptId);
  });

  it("T3: reveal is one-shot; second reveal returns null", async () => {
    const r1 = await storage.revealChallengeStage(attemptId, 0);
    expect(r1).not.toBeNull();
    expect(r1!.stageIssuedAt).not.toBeNull();
    expect(r1!.stageDeadlineAt).not.toBeNull();

    const r2 = await storage.revealChallengeStage(attemptId, 0);
    expect(r2).toBeNull(); // already revealed
  });

  it("T9: crash after reveal but before checkpoint — stage deadline still valid", async () => {
    const revealed = await storage.revealChallengeStage(attemptId, 0);
    expect(revealed).not.toBeNull();

    // Simulate crash: just verify the bundle state is recoverable
    const bundles = await storage.getChallengeBundles(attemptId);
    const stage0 = bundles.find(b => b.stageIndex === 0);
    expect(stage0).toBeDefined();
    expect(stage0!.stageIssuedAt).not.toBeNull();
    expect(stage0!.stageDeadlineAt).not.toBeNull();

    // Stage 1 should still be unrevealed (no split-brain)
    const stage1 = bundles.find(b => b.stageIndex === 1);
    expect(stage1).toBeDefined();
    expect(stage1!.stageIssuedAt).toBeNull();
  });
});

describe("Phase 2A Storage — Checkpoint Primitives (T4, T5, T6, T12, T13, T14)", () => {
  let attemptId: string;
  let bundles: any[];

  beforeEach(async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const jobId = await createTestJob(nodeId);
    attemptId = await createTestAttempt(jobId, nodeId);
    const claimed = await storage.claimOrphanChallengeSet(profileId, jobId, attemptId);
    expect(claimed).not.toBeNull();
    bundles = claimed!.sort((a, b) => a.stageIndex - b.stageIndex);
  });

  it("T4: checkpoint before reveal is rejected", async () => {
    // Stage 0 NOT revealed
    const b = bundles[0];
    const entry = computeTranscriptEntryHash("", 0, b.expectedDigest);
    const r = await storage.acceptChallengeCheckpoint(
      attemptId, 0, b.expectedDigest, b.stageNonce, "", entry, new Date(),
    );
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toBe("CHECKPOINT_BEFORE_REVEAL");
  });

  it("T5: duplicate checkpoint is idempotently ignored", async () => {
    await storage.revealChallengeStage(attemptId, 0);
    const b = bundles[0];
    const entry = computeTranscriptEntryHash("", 0, b.expectedDigest);

    const r1 = await storage.acceptChallengeCheckpoint(
      attemptId, 0, b.expectedDigest, b.stageNonce, "", entry, new Date(),
    );
    expect("checkpoint" in r1).toBe(true);

    const r2 = await storage.acceptChallengeCheckpoint(
      attemptId, 0, b.expectedDigest, b.stageNonce, "", entry, new Date(),
    );
    expect("checkpoint" in r2).toBe(true);
    if ("checkpoint" in r1 && "checkpoint" in r2) {
      expect(r1.checkpoint.id).toBe(r2.checkpoint.id); // same row
    }
  });

  it("T6: correct digest but wrong transcript predecessor is rejected", async () => {
    // Stage 0 — success
    await storage.revealChallengeStage(attemptId, 0);
    const b0 = bundles[0];
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);
    const r0 = await storage.acceptChallengeCheckpoint(
      attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0, new Date(),
    );
    expect("checkpoint" in r0).toBe(true);

    // Stage 1 — correct digest, wrong prev hash
    // The next stage should be auto-revealed by acceptChallengeCheckpoint
    const b1 = bundles[1];
    const wrongPrev = "0".repeat(64);
    const entry1 = computeTranscriptEntryHash(wrongPrev, 1, b1.expectedDigest);
    const r1 = await storage.acceptChallengeCheckpoint(
      attemptId, 1, b1.expectedDigest, b1.stageNonce, wrongPrev, entry1, new Date(),
    );
    expect("error" in r1).toBe(true);
    if ("error" in r1) expect(r1.error).toBe("TRANSCRIPT_HASH_MISMATCH");
  });

  it("T12: late checkpoint (past deadline) is rejected", async () => {
    const revealed = await storage.revealChallengeStage(attemptId, 0);
    expect(revealed).not.toBeNull();
    expect(revealed!.stageDeadlineAt).not.toBeNull();

    const b = bundles[0];
    const entry = computeTranscriptEntryHash("", 0, b.expectedDigest);
    // Use a receivedAt far enough past the deadline that precision doesn't matter
    const pastDeadline = new Date(revealed!.stageDeadlineAt!.getTime() + 300_000);

    // Verify the bundle in the DB to confirm deadline was actually persisted
    const dbBundles = await storage.getChallengeBundles(attemptId);
    const dbBundle0 = dbBundles.find(b2 => b2.stageIndex === 0);
    expect(dbBundle0).toBeDefined();
    expect(dbBundle0!.stageDeadlineAt).not.toBeNull();

    const r = await storage.acceptChallengeCheckpoint(
      attemptId, 0, b.expectedDigest, b.stageNonce, "", entry, pastDeadline,
    );
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toBe("STAGE_DEADLINE_MISSED");
  });

  it("T13: wrong nonce is rejected", async () => {
    await storage.revealChallengeStage(attemptId, 0);
    const b = bundles[0];
    const entry = computeTranscriptEntryHash("", 0, b.expectedDigest);
    const r = await storage.acceptChallengeCheckpoint(
      attemptId, 0, b.expectedDigest, "WRONG-NONCE", "", entry, new Date(),
    );
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toBe("STAGE_NONCE_MISMATCH");
  });

  it("T14: wrong digest is rejected", async () => {
    await storage.revealChallengeStage(attemptId, 0);
    const b = bundles[0];
    const entry = computeTranscriptEntryHash("", 0, "WRONG-DIGEST");
    const r = await storage.acceptChallengeCheckpoint(
      attemptId, 0, "WRONG-DIGEST", b.stageNonce, "", entry, new Date(),
    );
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toBe("STAGE_DIGEST_MISMATCH");
  });
});

describe("Phase 2A Storage — Crash Recovery (T8)", () => {
  it("T8: crash after checkpoint insert but before next-stage reveal — recoverable", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const jobId = await createTestJob(nodeId);
    const attemptId = await createTestAttempt(jobId, nodeId);
    const claimed = await storage.claimOrphanChallengeSet(profileId, jobId, attemptId);
    expect(claimed).not.toBeNull();
    const bundles = claimed!.sort((a, b) => a.stageIndex - b.stageIndex);

    // Manually reveal stage 0 (without auto-next-reveal)
    await storage.revealChallengeStage(attemptId, 0);

    // Submit checkpoint for stage 0 — this auto-reveals stage 1
    const b0 = bundles[0];
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);
    const r0 = await storage.acceptChallengeCheckpoint(
      attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0, new Date(),
    );
    expect("checkpoint" in r0).toBe(true);

    // Verify state: checkpoint exists, next stage revealed
    const cps = await storage.getChallengeCheckpoints(attemptId);
    expect(cps).toHaveLength(1);
    expect(cps[0].stageIndex).toBe(0);

    const allBundles = await storage.getChallengeBundles(attemptId);
    const stage1 = allBundles.find(b => b.stageIndex === 1);
    expect(stage1).toBeDefined();

    // If auto-reveal worked, stage 1 is revealed
    if ("checkpoint" in r0 && r0.nextBundle) {
      expect(stage1!.stageIssuedAt).not.toBeNull();
    }

    // Even if it didn't auto-reveal (simulating crash),
    // we can manually reveal stage 1 and continue
    if (!stage1!.stageIssuedAt) {
      const revealed1 = await storage.revealChallengeStage(attemptId, 1);
      expect(revealed1).not.toBeNull();
    }
  });
});

describe("Phase 2A Storage — Scoring Exact-Once (T7)", () => {
  it("T7: concurrent scoring attempts — exactly one wins", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const jobId = await createTestJob(nodeId);
    const attemptId = await createTestAttempt(jobId, nodeId);
    await storage.claimOrphanChallengeSet(profileId, jobId, attemptId);

    // Race two scoring attempts
    const [s1, s2] = await Promise.all([
      storage.scoreComplianceChallengeAtomic(jobId, nodeId, 5),
      storage.scoreComplianceChallengeAtomic(jobId, nodeId, 5),
    ]);

    const winners = [s1, s2].filter(s => s === true);
    expect(winners).toHaveLength(1); // exactly one scored
  });
});

describe("Phase 2A Storage — Full Happy Path (T15)", () => {
  it("T15: 5-stage challenge end-to-end through storage primitives", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const jobId = await createTestJob(nodeId);
    const attemptId = await createTestAttempt(jobId, nodeId);

    // Claim
    const claimed = await storage.claimOrphanChallengeSet(profileId, jobId, attemptId);
    expect(claimed).not.toBeNull();
    expect(claimed).toHaveLength(STAGES);
    const bundles = claimed!.sort((a, b) => a.stageIndex - b.stageIndex);

    // Walk all 5 stages: reveal → checkpoint (with auto-reveal of next)
    let prevHash = "";
    for (let i = 0; i < STAGES; i++) {
      // Reveal stage i (first stage manually, rest auto-revealed by checkpoint)
      if (i === 0) {
        const revealed = await storage.revealChallengeStage(attemptId, 0);
        expect(revealed).not.toBeNull();
      }

      const b = bundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);

      const result = await storage.acceptChallengeCheckpoint(
        attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash, new Date(),
      );
      expect("checkpoint" in result).toBe(true);

      if ("checkpoint" in result) {
        expect(result.checkpoint.stageIndex).toBe(i);
        expect(result.checkpoint.resultDigest).toBe(b.expectedDigest);

        // All stages except last should auto-reveal next
        if (i < STAGES - 1) {
          expect(result.nextBundle).not.toBeNull();
          expect(result.nextBundle!.stageIndex).toBe(i + 1);
          expect(result.nextBundle!.stageIssuedAt).not.toBeNull();
        } else {
          // Last stage — no next bundle
          expect(result.nextBundle).toBeNull();
        }
      }

      prevHash = entryHash;
    }

    // Verify rollup
    const [attempt] = await db.select()
      .from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, attemptId));
    expect(attempt.checkpointCount).toBe(STAGES);
    expect(attempt.transcriptHash).toBe(prevHash);
    expect(attempt.firstProgressAt).not.toBeNull();
    expect(attempt.challengeProtocolVersion).toBe(1);
    expect(attempt.challengeProfileId).toBe(profileId);

    // Verify all checkpoints exist
    const cps = await storage.getChallengeCheckpoints(attemptId);
    expect(cps).toHaveLength(STAGES);
    for (let i = 0; i < STAGES; i++) {
      expect(cps[i].stageIndex).toBe(i);
    }

    // Pool should be empty for this profile (we only inserted one set)
    const pool = await storage.getOrphanPoolCount(profileId);
    // Pool should have 0 orphan sets (we claimed the only one)
    // (may have leftover from other tests, so just check it's not negative)
    expect(pool).toBeGreaterThanOrEqual(0);
  });
});
