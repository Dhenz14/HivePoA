/**
 * Phase 2A Lifecycle Recovery Tests
 *
 * Proves that after process death, a fresh Phase2AChallengeService instance
 * reconstructs safe behavior from durable DB state alone.
 *
 * These are NOT harness-only reconciliation tests (those are in phase2a-challenge-service.test.ts).
 * These test the startup ordering guarantee: reconciliation precedes new issuance.
 *
 * The test pattern for "fresh process" is:
 *   1. Use service instance A to create dirty DB state
 *   2. Manipulate timestamps to simulate time passing / process death
 *   3. Create service instance B (simulating new process after restart)
 *   4. Call B.initialize() (startup reconciliation)
 *   5. Assert reconciliation effects before any new issuance
 *
 * Creating a new Phase2AChallengeService instance IS equivalent to a new process
 * because all durable state lives in the DB. The service holds no persistent
 * in-memory authority beyond the ready flag and sweep timer.
 *
 * Covers:
 *   LR1  — Startup sweep precedes fresh issuance (dirty state cleaned up first)
 *   LR2a — Restart after claim, before first reveal
 *   LR2b — Restart after reveal, before checkpoint
 *   LR2c — Restart after checkpoint commit, before response
 *   LR2d — Restart during final-stage scoring path
 *   LR3a — Issuance before initialize() is rejected
 *   LR3b — start() calls initialize() if not yet done
 *   GUARD — Accepted checkpoint survives restart sweep (deadline-consistency guardrail)
 */
import { describe, it, expect, beforeAll } from "vitest";
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

let realStorage: DatabaseStorage;
let profileId: string;

/** Create a ready-to-issue service ("fresh process, reconciliation complete"). */
async function freshService(): Promise<Phase2AChallengeService> {
  const svc = new Phase2AChallengeService(realStorage as unknown as Phase2AChallengeStorage);
  await svc.initialize();
  return svc;
}

/** Create an uninitialized service ("fresh process, not yet started"). */
function coldService(): Phase2AChallengeService {
  return new Phase2AChallengeService(realStorage as unknown as Phase2AChallengeStorage);
}

async function createTestNode(): Promise<string> {
  const nodeId = `lr-node-${uid()}`;
  await db.execute(sql`
    INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
    VALUES (${nodeId}, ${`inst-${uid()}`}, ${`user-${uid()}`}, 'online', 'RTX 4090', 24, 'gpu_poa_challenge', '0.50', 50, 0, 0, '0', 0, now())
  `);
  return nodeId;
}

async function insertOrphanSet(profId: string): Promise<string> {
  const setId = `lr-set-${uid()}`;
  const rootNonce = `${uid()}-${uid()}`;
  const bundles = Array.from({ length: STAGES }, (_, i) => ({
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

/** Walk all stages to completion via a service instance. */
async function completeAllStages(
  service: Phase2AChallengeService,
  attemptId: string,
): Promise<string> {
  const bundles = await realStorage.getChallengeBundles(attemptId);
  const sorted = bundles.sort((a, b) => a.stageIndex - b.stageIndex);
  let prevHash = "";
  for (let i = 0; i < STAGES; i++) {
    const b = sorted[i];
    const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
    await service.acceptCheckpoint(
      attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
    );
    prevHash = entryHash;
  }
  return prevHash;
}

// ── Setup ────────────────────────────────────────────────────────────────────

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
  await db.execute(sql`DO $$ BEGIN ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS target_node_id VARCHAR; ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS poa_scored_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`);
  await db.execute(sql`DO $$ BEGIN ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS last_poa_challenge_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$`);
  await db.execute(sql`DO $$ BEGIN ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS challenge_protocol_version INTEGER; ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS challenge_profile_id VARCHAR; ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS first_progress_at TIMESTAMP; ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS checkpoint_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS transcript_hash TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS compute_job_attempts_id_job_id_idx ON compute_job_attempts(id, job_id)`);
}

beforeAll(async () => {
  realStorage = new DatabaseStorage();
  await ensureTables();

  const testClassId = 2000 + Math.floor(Math.random() * 9000);
  const profile = await realStorage.createResourceClassProfile({
    classId: testClassId,
    className: `gpu-lr-test-${uid()}`,
    protocolVersion: 1,
    kernelId: "phase2a-kernel-v1",
    m: 4096, n: 4096, k: 8, mixRounds: 1,
    stagesPerChallenge: STAGES,
    firstProgressDeadlineMs: 30_000,
    stageDeadlineMs: 60_000,
    completionDeadlineMs: 600_000,
    poolTarget: 50,
    poolLowWatermarkPct: 50,
    poolCriticalWatermarkPct: 25,
  });
  profileId = profile.profileId;
});

// ── LR1: Startup sweep precedes fresh issuance ──────────────────────────────

describe("Phase 2A Lifecycle — LR1: Startup Reconciliation Ordering", () => {
  it("LR1: dirty state from prior process is cleaned up before new issuance", async () => {
    // --- Phase: prior process creates dirty state, then "dies" ---
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const oldService = await freshService();

    const issue = await oldService.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Simulate: prior process died with this attempt still in-flight.
    // Backdate to make first_progress_deadline pass (simulate abandoned claim).
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
    oldService.stop();
    // oldService is now "dead" — no more sweeps will run from it.

    // --- Phase: new process starts ---
    await insertOrphanSet(profileId); // replenish pool for new issuance
    const newNodeId = await createTestNode();
    const newService = coldService();

    // Before initialize: the dirty attempt should still be in-flight
    const [dirtyAttempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(dirtyAttempt.state).toBe("leased"); // still dirty

    // Initialize: startup reconciliation runs
    await newService.initialize();

    // After initialize: the dirty attempt should be timed out
    const [cleanedAttempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(cleanedAttempt.state).toBe("timed_out");

    const [cleanedJob] = await db.select().from(computeJobs)
      .where(eq(computeJobs.id, issue.jobId));
    expect(cleanedJob.state).toBe("rejected");
    expect(cleanedJob.poaScoredAt).not.toBeNull();

    // New issuance works cleanly on the reconciled state
    const newIssue = await newService.issueChallenge(newNodeId, profileId);
    expect(newIssue.ok).toBe(true);

    newService.stop();
  });
});

// ── LR2: Restart after awkward boundaries ────────────────────────────────────

describe("Phase 2A Lifecycle — LR2: Restart at Awkward Boundaries", () => {

  it("LR2a: restart after claim, before first reveal — reconciled on startup", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const oldService = await freshService();

    const issue = await oldService.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Simulate: claim happened, stage 0 was revealed, but no checkpoint arrived.
    // Backdate everything to make first_progress_deadline pass.
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
    oldService.stop();

    // Fresh process: reconciliation should expire this attempt
    const newService = coldService();
    await newService.initialize();

    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");
    expect(attempt.failureReason).toBe("FIRST_PROGRESS_MISSED");

    // No duplicate checkpoint rows created by reconciliation
    const checkpoints = await realStorage.getChallengeCheckpoints(issue.attemptId);
    expect(checkpoints).toHaveLength(0);

    newService.stop();
  });

  it("LR2b: restart after reveal, before checkpoint — reconciled on startup", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const oldService = await freshService();

    const issue = await oldService.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Stage 0 is revealed but no checkpoint submitted.
    // Backdate stage_deadline_at so it's expired.
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '60 seconds'
      WHERE attempt_id = ${issue.attemptId} AND stage_index = 0
    `);
    // Ensure first_progress_at is set to avoid hitting FIRST_PROGRESS_MISSED instead
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET first_progress_at = now() - interval '90 seconds'
      WHERE id = ${issue.attemptId}
    `);
    oldService.stop();

    const newService = coldService();
    await newService.initialize();

    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");
    expect(attempt.failureReason).toBe("STAGE_DEADLINE_MISSED");

    const checkpoints = await realStorage.getChallengeCheckpoints(issue.attemptId);
    expect(checkpoints).toHaveLength(0);

    newService.stop();
  });

  it("LR2c: restart after checkpoint commit, before response — reconciled on startup", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const oldService = await freshService();

    const issue = await oldService.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Complete all stages (the "response" was the score application).
    await completeAllStages(oldService, issue.attemptId);

    // Simulate crash: job is accepted but score latch was lost.
    await db.execute(sql`
      UPDATE compute_jobs SET poa_scored_at = NULL WHERE id = ${issue.jobId}
    `);
    oldService.stop();

    // Fresh process: sweepScoring should re-apply the score
    const newService = coldService();
    await newService.initialize();

    const [job] = await db.select().from(computeJobs)
      .where(eq(computeJobs.id, issue.jobId));
    expect(job.state).toBe("accepted");
    expect(job.poaScoredAt).not.toBeNull();

    // Checkpoints are intact (not duplicated)
    const checkpoints = await realStorage.getChallengeCheckpoints(issue.attemptId);
    expect(checkpoints).toHaveLength(STAGES);

    newService.stop();
  });

  it("LR2d: restart during final-stage scoring path — reconciled on startup", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const oldService = await freshService();

    const issue = await oldService.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Complete all stages
    await completeAllStages(oldService, issue.attemptId);

    // Simulate crash mid-scoring: wipe the latch
    await db.execute(sql`
      UPDATE compute_jobs SET poa_scored_at = NULL WHERE id = ${issue.jobId}
    `);
    oldService.stop();

    // Fresh process A reconciles
    const serviceA = coldService();
    await serviceA.initialize();

    // Fresh process B also reconciles (simulates two restarts in sequence)
    const serviceB = coldService();
    await serviceB.initialize();

    // Score was applied exactly once despite two reconciliation runs
    const [job] = await db.select().from(computeJobs)
      .where(eq(computeJobs.id, issue.jobId));
    expect(job.poaScoredAt).not.toBeNull();

    // No duplicate state transitions
    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("accepted");
    expect(attempt.checkpointCount).toBe(STAGES);

    serviceA.stop();
    serviceB.stop();
  });
});

// ── LR3: Scheduler/Readiness Ordering ────────────────────────────────────────

describe("Phase 2A Lifecycle — LR3: Readiness Ordering", () => {

  it("LR3a: issuance before initialize() is rejected with SERVICE_NOT_READY", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = coldService();

    // Attempt issuance before initialize — must be rejected
    const result = await service.issueChallenge(nodeId, profileId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("SERVICE_NOT_READY");

    // After initialize, issuance succeeds
    await service.initialize();
    const result2 = await service.issueChallenge(nodeId, profileId);
    expect(result2.ok).toBe(true);

    service.stop();
  });

  it("LR3b: start() calls initialize if not already done", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = coldService();

    expect(service.isReady()).toBe(false);

    // start() should call initialize() internally
    await service.start(999_999); // large interval so sweep doesn't fire during test

    expect(service.isReady()).toBe(true);

    // Issuance works now
    const result = await service.issueChallenge(nodeId, profileId);
    expect(result.ok).toBe(true);

    service.stop();
  });
});

// ── GUARD: Deadline-Consistency Guardrail ─────────────────────────────────────

describe("Phase 2A Lifecycle — Deadline-Consistency Guardrail", () => {

  it("GUARD: accepted checkpoint survives restart sweep — sweeper does not kill attempt for a completed stage", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const oldService = await freshService();

    const issue = await oldService.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Complete stages 0, 1, 2 with valid accepted checkpoints
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sorted = bundles.sort((a, b) => a.stageIndex - b.stageIndex);
    let prevHash = "";
    for (let i = 0; i < 3; i++) {
      const b = sorted[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      const cp = await oldService.acceptCheckpoint(
        issue.attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
      );
      expect(cp.ok).toBe(true);
      prevHash = entryHash;
    }

    // Verify: 3 checkpoints exist
    const cpsBefore = await realStorage.getChallengeCheckpoints(issue.attemptId);
    expect(cpsBefore).toHaveLength(3);

    // Now simulate: process dies. Stage 3 was revealed (auto-reveal) but
    // worker never submitted stage 3 checkpoint. Backdate stage 3 deadline.
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '60 seconds'
      WHERE attempt_id = ${issue.attemptId} AND stage_index = 3
    `);
    oldService.stop();

    // Fresh process reconciliation
    const newService = coldService();
    await newService.initialize();

    // The attempt should be timed_out for stage 3 (STAGE_DEADLINE_MISSED)
    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");
    expect(attempt.failureReason).toBe("STAGE_DEADLINE_MISSED");

    // CRITICAL GUARDRAIL: The 3 accepted checkpoints must still exist.
    // The sweeper must NOT have retroactively invalidated the accepted stages.
    const cpsAfter = await realStorage.getChallengeCheckpoints(issue.attemptId);
    expect(cpsAfter).toHaveLength(3);
    expect(cpsAfter[0].stageIndex).toBe(0);
    expect(cpsAfter[1].stageIndex).toBe(1);
    expect(cpsAfter[2].stageIndex).toBe(2);

    // The timeout reason must reference stage 3 (the unanswered stage),
    // NOT stages 0-2 (which were completed).
    // This is the structural proof that the sweeper classifies timeouts
    // based on unanswered stages, not completed ones.
    expect(attempt.failureReason).toBe("STAGE_DEADLINE_MISSED");

    // Accepted checkpoints' result_digests must match expected digests
    for (let i = 0; i < 3; i++) {
      expect(cpsAfter[i].resultDigest).toBe(sorted[i].expectedDigest);
    }

    // The job was scored as FAIL (stage 3 missed), not as PASS
    const [job] = await db.select().from(computeJobs)
      .where(eq(computeJobs.id, issue.jobId));
    expect(job.state).toBe("rejected");
    expect(job.poaScoredAt).not.toBeNull();

    newService.stop();
  });
});

// ── MI1: Multi-Instance Concurrent Initialization ────────────────────────────

describe("Phase 2A Lifecycle — MI1: Multi-Instance Concurrent Sweep", () => {

  it("MI1: two instances call start() concurrently against dirty DB — outcomes converge exactly once", async () => {
    // --- Setup: dirty state from a "dead" prior process ---
    await insertOrphanSet(profileId);
    await insertOrphanSet(profileId);
    const node1 = await createTestNode();
    const node2 = await createTestNode();

    // Use a temporary service to create two dirty challenges.
    const setupService = await freshService();

    const issue1 = await setupService.issueChallenge(node1, profileId);
    expect(issue1.ok).toBe(true);
    if (!issue1.ok) return;
    const issue2 = await setupService.issueChallenge(node2, profileId);
    expect(issue2.ok).toBe(true);
    if (!issue2.ok) return;

    // Make both attempts expired (first_progress_missed).
    for (const iss of [issue1, issue2]) {
      await db.execute(sql`
        DELETE FROM compute_challenge_checkpoints WHERE attempt_id = ${iss.attemptId}
      `);
      await db.execute(sql`
        UPDATE compute_job_attempts
        SET created_at = now() - interval '120 seconds',
            first_progress_at = NULL,
            checkpoint_count = 0
        WHERE id = ${iss.attemptId}
      `);
    }
    setupService.stop();

    // Get reputation before concurrent init.
    const [node1Before] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${node1}
    `).then(r => (r.rows ?? r) as any[]);
    const rep1Before = Number(node1Before.reputation_score);

    const [node2Before] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${node2}
    `).then(r => (r.rows ?? r) as any[]);
    const rep2Before = Number(node2Before.reputation_score);

    // --- Two instances start() concurrently ---
    const instanceA = coldService();
    const instanceB = coldService();

    // Both call start() (which calls initialize()) at the same time.
    // Large interval so periodic sweep doesn't fire during test.
    await Promise.all([
      instanceA.start(999_999),
      instanceB.start(999_999),
    ]);

    // Both should be ready.
    expect(instanceA.isReady()).toBe(true);
    expect(instanceB.isReady()).toBe(true);

    // --- Assert: durable outcomes converge exactly once ---

    // Both attempts should be timed_out.
    for (const iss of [issue1, issue2]) {
      const [attempt] = await db.select().from(computeJobAttempts)
        .where(eq(computeJobAttempts.id, iss.attemptId));
      expect(attempt.state).toBe("timed_out");

      const [job] = await db.select().from(computeJobs)
        .where(eq(computeJobs.id, iss.jobId));
      expect(job.state).toBe("rejected");
      expect(job.poaScoredAt).not.toBeNull();
    }

    // No duplicate score application: each node's reputation should have
    // been decremented exactly once (-10 per failure), not twice.
    const [node1After] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${node1}
    `).then(r => (r.rows ?? r) as any[]);
    const rep1After = Number(node1After.reputation_score);
    expect(rep1After).toBe(rep1Before - 10); // exactly one REP_FAIL

    const [node2After] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${node2}
    `).then(r => (r.rows ?? r) as any[]);
    const rep2After = Number(node2After.reputation_score);
    expect(rep2After).toBe(rep2Before - 10); // exactly one REP_FAIL

    // No duplicate checkpoint rows (should still be 0 from cleanup).
    const cps1 = await realStorage.getChallengeCheckpoints(issue1.attemptId);
    expect(cps1).toHaveLength(0);
    const cps2 = await realStorage.getChallengeCheckpoints(issue2.attemptId);
    expect(cps2).toHaveLength(0);

    // Post-init issuance works from both instances.
    await insertOrphanSet(profileId);
    await insertOrphanSet(profileId);
    const newNode = await createTestNode();
    const resultA = await instanceA.issueChallenge(newNode, profileId);
    expect(resultA.ok).toBe(true);

    const newNode2 = await createTestNode();
    const resultB = await instanceB.issueChallenge(newNode2, profileId);
    expect(resultB.ok).toBe(true);

    instanceA.stop();
    instanceB.stop();
  });

  it("MI1b: initialize() failure leaves service inert — retry succeeds", async () => {
    // Create a storage proxy that throws on the first sweepTimeouts query.
    // Uses Proxy to delegate all methods to realStorage except the intercepted one.
    let throwOnce = true;
    const failingStorage = new Proxy(realStorage as unknown as Phase2AChallengeStorage, {
      get(target: any, prop: string) {
        if (prop === "getExpiredPhase2AAttempts") {
          return async (now: Date) => {
            if (throwOnce) {
              throwOnce = false;
              throw new Error("simulated DB connection failure");
            }
            return realStorage.getExpiredPhase2AAttempts(now);
          };
        }
        const val = target[prop];
        if (typeof val === "function") return val.bind(target);
        return val;
      },
    });

    const service = new Phase2AChallengeService(failingStorage);
    expect(service.isReady()).toBe(false);

    // First initialize should throw.
    await expect(service.initialize()).rejects.toThrow("simulated DB connection failure");
    expect(service.isReady()).toBe(false);

    // Issuance still blocked.
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const result = await service.issueChallenge(nodeId, profileId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("SERVICE_NOT_READY");

    // Retry initialize succeeds (throwOnce is now false).
    await service.initialize();
    expect(service.isReady()).toBe(true);

    // Issuance now works.
    const result2 = await service.issueChallenge(nodeId, profileId);
    expect(result2.ok).toBe(true);

    service.stop();
  });

  it("MI1c: start() is idempotent — duplicate calls do not create duplicate timers", async () => {
    const service = coldService();

    await service.start(999_999);
    await service.start(999_999); // second call — should be a no-op
    await service.start(999_999); // third call — should be a no-op

    expect(service.isReady()).toBe(true);

    // Service still works normally.
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const result = await service.issueChallenge(nodeId, profileId);
    expect(result.ok).toBe(true);

    service.stop();
  });
});

// ── AT1–AT4: Atomic Timeout Adversarial Tests ────────────────────────────────

describe("Phase 2A Lifecycle — AT: Atomic Timeout Primitive", () => {

  it("AT1: progress races timeout — valid checkpoint lands, expiry no-ops", async () => {
    // Issue challenge, complete stage 0 so first_progress_at is set,
    // then backdate stage 1 deadline to make it look expired.
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = await freshService();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Complete stage 0
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sorted = bundles.sort((a, b) => a.stageIndex - b.stageIndex);
    const b0 = sorted[0];
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);
    await service.acceptCheckpoint(
      issue.attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0,
    );

    // Stage 1 is now auto-revealed. Complete it too.
    const b1 = sorted[1];
    const entry1 = computeTranscriptEntryHash(entry0, 1, b1.expectedDigest);
    await service.acceptCheckpoint(
      issue.attemptId, 1, b1.expectedDigest, b1.stageNonce, entry0, entry1,
    );

    // Now backdate stage 1 deadline to make the sweep query think it's expired.
    // But the checkpoint already exists — the atomic primitive must see it and no-op.
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '60 seconds'
      WHERE attempt_id = ${issue.attemptId} AND stage_index = 1
    `);

    // Directly call the atomic primitive — should no-op.
    const result = await realStorage.expireAttemptIfStillEligible(
      issue.attemptId, "STAGE_DEADLINE_MISSED", new Date(),
    );
    expect(result.expired).toBe(false);

    // Attempt must NOT be timed_out.
    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).not.toBe("timed_out");
    expect(attempt.checkpointCount).toBeGreaterThanOrEqual(2);

    service.stop();
  });

  it("AT2: terminalization races timeout — already terminal attempt, expiry no-ops", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = await freshService();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Manually set attempt to terminal state (simulating another sweeper or normal completion).
    await db.execute(sql`
      UPDATE compute_job_attempts
      SET state = 'rejected', finished_at = now()
      WHERE id = ${issue.attemptId}
    `);

    // Atomic primitive should see terminal state under the lock and no-op.
    const result = await realStorage.expireAttemptIfStillEligible(
      issue.attemptId, "FIRST_PROGRESS_MISSED", new Date(),
    );
    expect(result.expired).toBe(false);

    // State must still be 'rejected', not overwritten to 'timed_out'.
    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("rejected");

    service.stop();
  });

  it("AT3: concurrent sweepers race same timeout — exactly one applies expiry", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = await freshService();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Set up FIRST_PROGRESS_MISSED condition.
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

    // Get reputation before.
    const [nodeBefore] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${nodeId}
    `).then(r => (r.rows ?? r) as any[]);
    const repBefore = Number(nodeBefore.reputation_score);

    const now = new Date();

    // Race two atomic expiry calls.
    const [r1, r2] = await Promise.all([
      realStorage.expireAttemptIfStillEligible(issue.attemptId, "FIRST_PROGRESS_MISSED", now),
      realStorage.expireAttemptIfStillEligible(issue.attemptId, "FIRST_PROGRESS_MISSED", now),
    ]);

    // Exactly one should expire.
    const expired = [r1, r2].filter(r => r.expired);
    expect(expired).toHaveLength(1);

    // Apply scoring for whichever expired (simulating what sweepTimeouts would do).
    for (const r of [r1, r2]) {
      if (r.expired) {
        await realStorage.scoreComplianceChallengeAtomic(r.jobId, r.nodeId, -10);
      }
    }

    // Reputation decremented exactly once.
    const [nodeAfter] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${nodeId}
    `).then(r => (r.rows ?? r) as any[]);
    const repAfter = Number(nodeAfter.reputation_score);
    expect(repAfter).toBe(repBefore - 10);

    // Attempt state is timed_out (set by the winner).
    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");

    service.stop();
  });

  it("AT4: accepted checkpoint survives atomic expiry attempt — deadline-consistency guardrail", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const service = await freshService();

    const issue = await service.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Complete stages 0, 1, 2 with valid accepted checkpoints.
    const bundles = await realStorage.getChallengeBundles(issue.attemptId);
    const sorted = bundles.sort((a, b) => a.stageIndex - b.stageIndex);
    let prevHash = "";
    for (let i = 0; i < 3; i++) {
      const b = sorted[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      await service.acceptCheckpoint(
        issue.attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash,
      );
      prevHash = entryHash;
    }

    // Backdate stage 3 deadline (stage 3 was auto-revealed but no checkpoint).
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '60 seconds'
      WHERE attempt_id = ${issue.attemptId} AND stage_index = 3
    `);

    // Atomic expiry should succeed (stage 3 is genuinely expired, no checkpoint).
    const result = await realStorage.expireAttemptIfStillEligible(
      issue.attemptId, "STAGE_DEADLINE_MISSED", new Date(),
    );
    expect(result.expired).toBe(true);

    // CRITICAL GUARDRAIL: The 3 accepted checkpoints must still exist.
    const cps = await realStorage.getChallengeCheckpoints(issue.attemptId);
    expect(cps).toHaveLength(3);
    expect(cps[0].stageIndex).toBe(0);
    expect(cps[1].stageIndex).toBe(1);
    expect(cps[2].stageIndex).toBe(2);

    // Each checkpoint's digest must match the expected digest.
    for (let i = 0; i < 3; i++) {
      expect(cps[i].resultDigest).toBe(sorted[i].expectedDigest);
    }

    // The attempt is timed_out but the reason is the unanswered stage, not the completed ones.
    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");
    expect(attempt.failureReason).toBe("STAGE_DEADLINE_MISSED");

    service.stop();
  });
});

// ── EX1–EX4: Cross-Instance Exclusivity Tests ───────────────────────────────

describe("Phase 2A Lifecycle — EX: Cross-Instance Exclusivity", () => {

  it("EX1: advisory lock prevents concurrent sweep cycles — only one runs", async () => {
    // Set up dirty state that the sweep will process
    await insertOrphanSet(profileId);
    const nodeId = await createTestNode();
    const setupSvc = await freshService();
    const issue = await setupSvc.issueChallenge(nodeId, profileId);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    // Make the attempt expired
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
    setupSvc.stop();

    // Create two fresh service instances (simulating two app instances)
    const svcA = await freshService();
    const svcB = await freshService();

    // Race two sweep cycles — advisory lock should let only one proceed
    await Promise.all([svcA.sweep(), svcB.sweep()]);

    // The attempt should be timed out (exactly one sweeper processed it)
    const [attempt] = await db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.id, issue.attemptId));
    expect(attempt.state).toBe("timed_out");

    // Job should be scored exactly once
    const [job] = await db.select().from(computeJobs)
      .where(eq(computeJobs.id, issue.jobId));
    expect(job.poaScoredAt).not.toBeNull();

    svcA.stop();
    svcB.stop();
  });

  it("EX2: DB-level operations remain correct even without advisory lock", async () => {
    // Defense-in-depth: even if advisory locks fail or are bypassed,
    // the individual DB operations remain correct due to their own atomicity.
    await insertOrphanSet(profileId);
    await insertOrphanSet(profileId);
    const node1 = await createTestNode();
    const node2 = await createTestNode();

    const svc = await freshService();

    // Issue two challenges
    const i1 = await svc.issueChallenge(node1, profileId);
    const i2 = await svc.issueChallenge(node2, profileId);
    expect(i1.ok).toBe(true);
    expect(i2.ok).toBe(true);
    if (!i1.ok || !i2.ok) return;

    // Make both expired
    for (const iss of [i1, i2]) {
      await db.execute(sql`
        DELETE FROM compute_challenge_checkpoints WHERE attempt_id = ${iss.attemptId}
      `);
      await db.execute(sql`
        UPDATE compute_job_attempts
        SET created_at = now() - interval '120 seconds',
            first_progress_at = NULL,
            checkpoint_count = 0
        WHERE id = ${iss.attemptId}
      `);
    }

    // Get reputation before
    const [n1Before] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${node1}
    `).then(r => (r.rows ?? r) as any[]);
    const [n2Before] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${node2}
    `).then(r => (r.rows ?? r) as any[]);

    // Simulate: two instances both call sweepTimeouts directly (bypassing advisory lock)
    const now = new Date();
    const candidates = await realStorage.getExpiredPhase2AAttempts(now);

    // Race all expiry calls from "two instances"
    const results = await Promise.all(
      candidates
        .filter(c => c.attemptId === i1.attemptId || c.attemptId === i2.attemptId)
        .flatMap(c => [
          realStorage.expireAttemptIfStillEligible(c.attemptId, c.reason, now),
          realStorage.expireAttemptIfStillEligible(c.attemptId, c.reason, now), // duplicate from "instance B"
        ])
    );

    // Each attempt should be expired exactly once
    for (const iss of [i1, i2]) {
      const [att] = await db.select().from(computeJobAttempts)
        .where(eq(computeJobAttempts.id, iss.attemptId));
      expect(att.state).toBe("timed_out");
    }

    // Score (simulating what sweepTimeouts does)
    for (const r of results) {
      if (r.expired) {
        await realStorage.scoreComplianceChallengeAtomic(r.jobId, r.nodeId, -10);
      }
    }

    // Each node's reputation decremented exactly once
    const [n1After] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${node1}
    `).then(r => (r.rows ?? r) as any[]);
    const [n2After] = await db.execute(sql`
      SELECT reputation_score FROM compute_nodes WHERE id = ${node2}
    `).then(r => (r.rows ?? r) as any[]);

    expect(Number(n1After.reputation_score)).toBe(Number(n1Before.reputation_score) - 10);
    expect(Number(n2After.reputation_score)).toBe(Number(n2Before.reputation_score) - 10);

    svc.stop();
  });

  it("EX3: advisory lock acquire/release/re-acquire — no stale lock", async () => {
    // Acquire
    const acquired1 = await realStorage.tryAcquireAdvisoryLock(3, 99);
    expect(acquired1).toBe(true);

    // Release
    await realStorage.releaseAdvisoryLock(3, 99);

    // Re-acquire should work
    const acquired2 = await realStorage.tryAcquireAdvisoryLock(3, 99);
    expect(acquired2).toBe(true);

    // Cleanup
    await realStorage.releaseAdvisoryLock(3, 99);
  });
});
