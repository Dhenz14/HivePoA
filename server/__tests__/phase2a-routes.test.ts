/**
 * Phase 2A HTTP API — Route-Level Adversarial Tests
 *
 * Tests the worker-facing and coordinator-facing HTTP routes for Phase 2A
 * against the real Express app with real database storage.
 *
 * These tests verify that:
 *   - HTTP layer correctly delegates to the service without adding workflow logic
 *   - Auth and ownership checks prevent cross-tenant access
 *   - Error surfaces map correctly to HTTP status codes
 *   - Frozen invariants are preserved through the API layer
 *
 * Covers:
 *   RT1 — Pre-ready issuance blocked at HTTP layer
 *   RT2 — Valid end-to-end API flow (issue → checkpoint → next stage → terminal)
 *   RT3 — Duplicate checkpoint submission is idempotent
 *   RT4 — Late checkpoint rejected with correct status
 *   RT5 — Wrong stage / wrong binding / cross-attempt submission rejected
 *   RT6 — Ambiguous retry after commit produces safe result
 *   RT7 — Terminal/timed-out attempt submissions fail cleanly
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createHash, randomUUID } from "crypto";
import type { Express } from "express";
import type { Server } from "http";
import { db } from "../db";
import { sql, eq } from "drizzle-orm";
import {
  computeResourceClassProfiles,
  computeChallengeStageB,
  computeChallengeCheckpoints,
  computeJobs,
  computeJobAttempts,
  computeNodes,
} from "@shared/schema";
import { DatabaseStorage } from "../storage";

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
const PREFIX = `rt-${Date.now().toString(36)}`;

let app: Express;
let httpServer: Server;
let storage: DatabaseStorage;
let profileId: string;

// Auth credentials — coordinator must match POA_COORDINATOR_USERNAME (default: "validator-police")
const COORD_TOKEN = `coord-token-${uid()}`;
const COORD_USER = process.env.POA_COORDINATOR_USERNAME ?? "validator-police";
const WORKER_API_KEY = `worker-key-${uid()}`;
const WORKER_USER = `worker-user-${uid()}`;

const coordAuth = { Authorization: `Bearer ${COORD_TOKEN}` };
const workerAuth = { Authorization: `ApiKey ${WORKER_API_KEY}` };

// ── Phase 2A table setup ─────────────────────────────────────────────────────

async function ensurePhase2ATables(): Promise<void> {
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

async function createWorkerNode(): Promise<string> {
  const nodeId = `${PREFIX}-node-${uid()}`;
  await db.execute(sql`
    INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
    VALUES (${nodeId}, ${`inst-${uid()}`}, ${WORKER_USER}, 'online', 'RTX 4090', 24, 'gpu_poa_challenge', '0.50', 50, 0, 0, '0', 0, now())
  `);
  return nodeId;
}

async function insertOrphanSet(profId: string): Promise<string> {
  const setId = `${PREFIX}-set-${uid()}`;
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
  await storage.insertPrecomputedBundleSet(bundles);
  return setId;
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  storage = new DatabaseStorage();
  await ensurePhase2ATables();

  // Create auth credentials
  // Session for coordinator (Bearer token)
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  await db.execute(sql`
    INSERT INTO user_sessions (token, username, role, expires_at, created_at)
    VALUES (${COORD_TOKEN}, ${COORD_USER}, 'user', ${expires}, now())
    ON CONFLICT (token) DO NOTHING
  `);
  // Agent key for worker (ApiKey)
  await storage.createAgentKey(WORKER_API_KEY, WORKER_USER, "phase2a-test-worker");

  // Create test profile
  const testClassId = 50000 + Math.floor(Math.random() * 9000);
  const profile = await storage.createResourceClassProfile({
    classId: testClassId,
    className: `gpu-rt-test-${uid()}`,
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

  // Create test app
  const { createTestApp } = await import("./test-app");
  const result = await createTestApp();
  app = result.app;
  httpServer = result.httpServer;
}, 30000);

afterAll(() => {
  httpServer?.close();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 2A Routes — RT1: Auth Enforcement", () => {
  it("RT1a: issuance without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/compute/challenges/issue")
      .send({ nodeId: "x", profileId: "y" });
    expect(res.status).toBe(401);
  });

  it("RT1b: checkpoint without auth returns 401", async () => {
    const res = await request(app)
      .post("/api/compute/challenges/fake-attempt/checkpoint")
      .send({ stageIndex: 0, resultDigest: "a".repeat(64), stageNonce: "b".repeat(64), transcriptPrevHash: "", transcriptEntryHash: "c".repeat(64) });
    expect(res.status).toBe(401);
  });

  it("RT1c: stage fetch without auth returns 401", async () => {
    const res = await request(app)
      .get("/api/compute/challenges/fake-attempt/stage");
    expect(res.status).toBe(401);
  });

  it("RT1d: status fetch without auth returns 401", async () => {
    const res = await request(app)
      .get("/api/compute/challenges/fake-attempt/status");
    expect(res.status).toBe(401);
  });
});

describe("Phase 2A Routes — RT2: Valid End-to-End API Flow", () => {
  it("RT2: issue → checkpoint all stages → terminal", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    // Issue challenge (coordinator auth)
    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    expect(issueRes.body.attemptId).toBeTruthy();
    expect(issueRes.body.stage.stageIndex).toBe(0);

    const { attemptId } = issueRes.body;

    // Get current stage (worker auth)
    const stageRes = await request(app)
      .get(`/api/compute/challenges/${attemptId}/stage`)
      .set(workerAuth);
    expect(stageRes.status).toBe(200);
    expect(stageRes.body.currentStage).not.toBeNull();
    expect(stageRes.body.currentStage.stageIndex).toBe(0);

    // Walk all 5 stages via checkpoint submissions
    const bundles = await storage.getChallengeBundles(attemptId);
    const sorted = bundles.sort((a, b) => a.stageIndex - b.stageIndex);

    let prevHash = "";
    for (let i = 0; i < STAGES; i++) {
      const b = sorted[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);

      const cpRes = await request(app)
        .post(`/api/compute/challenges/${attemptId}/checkpoint`)
        .set(workerAuth)
        .send({
          stageIndex: i,
          resultDigest: b.expectedDigest,
          stageNonce: b.stageNonce,
          transcriptPrevHash: prevHash,
          transcriptEntryHash: entryHash,
        });
      expect(cpRes.status).toBe(200);
      expect(cpRes.body.stageIndex).toBe(i);

      if (i < STAGES - 1) {
        expect(cpRes.body.final).toBe(false);
        expect(cpRes.body.nextStage).not.toBeNull();
      } else {
        expect(cpRes.body.final).toBe(true);
      }

      prevHash = entryHash;
    }

    // Status should be accepted
    const statusRes = await request(app)
      .get(`/api/compute/challenges/${attemptId}/status`)
      .set(workerAuth);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.state).toBe("accepted");
    expect(statusRes.body.completedStages).toBe(STAGES);
  });
});

describe("Phase 2A Routes — RT3: Duplicate Submission", () => {
  it("RT3: duplicate checkpoint submission is idempotent", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    const bundles = await storage.getChallengeBundles(attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);

    const body = {
      stageIndex: 0,
      resultDigest: b0.expectedDigest,
      stageNonce: b0.stageNonce,
      transcriptPrevHash: "",
      transcriptEntryHash: entry0,
    };

    // First submission
    const cp1 = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send(body);
    expect(cp1.status).toBe(200);

    // Duplicate submission — should return same checkpoint with full continuation state
    const cp2 = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send(body);
    expect(cp2.status).toBe(200);
    expect(cp2.body.checkpointId).toBe(cp1.body.checkpointId);
    // CRITICAL: duplicate response must include nextStage so retries are fully resumable
    expect(cp2.body.nextStage).not.toBeNull();
    expect(cp2.body.nextStage.stageIndex).toBe(1);
    expect(cp2.body.final).toBe(false);

    // Only one checkpoint row should exist
    const cps = await storage.getChallengeCheckpoints(attemptId);
    const stage0Cps = cps.filter(c => c.stageIndex === 0);
    expect(stage0Cps).toHaveLength(1);
  });
});

describe("Phase 2A Routes — RT4: Late Checkpoint", () => {
  it("RT4: checkpoint after deadline returns 408", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    // Backdate stage 0 deadline to the past
    await db.execute(sql`
      UPDATE compute_challenge_stage_bundles
      SET stage_deadline_at = now() - interval '300 seconds'
      WHERE attempt_id = ${attemptId} AND stage_index = 0
    `);

    const bundles = await storage.getChallengeBundles(attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);

    const res = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send({
        stageIndex: 0,
        resultDigest: b0.expectedDigest,
        stageNonce: b0.stageNonce,
        transcriptPrevHash: "",
        transcriptEntryHash: entry0,
      });
    expect(res.status).toBe(408);
    expect(res.body.error.code).toBe("STAGE_DEADLINE_MISSED");
  });
});

describe("Phase 2A Routes — RT5: Wrong Stage/Binding", () => {
  it("RT5a: wrong digest returns 400", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    const bundles = await storage.getChallengeBundles(attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const wrongDigest = "0".repeat(64);
    const entry0 = computeTranscriptEntryHash("", 0, wrongDigest);

    const res = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send({
        stageIndex: 0,
        resultDigest: wrongDigest,
        stageNonce: b0.stageNonce,
        transcriptPrevHash: "",
        transcriptEntryHash: entry0,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("STAGE_DIGEST_MISMATCH");
  });

  it("RT5b: wrong nonce returns 400", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    const bundles = await storage.getChallengeBundles(attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const wrongNonce = "f".repeat(64);
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);

    const res = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send({
        stageIndex: 0,
        resultDigest: b0.expectedDigest,
        stageNonce: wrongNonce,
        transcriptPrevHash: "",
        transcriptEntryHash: entry0,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("STAGE_NONCE_MISMATCH");
  });

  it("RT5c: nonexistent attempt returns 404", async () => {
    const res = await request(app)
      .get("/api/compute/challenges/nonexistent-attempt-id/stage")
      .set(workerAuth);
    expect(res.status).toBe(404);
  });

  it("RT5d: attempt owned by different user returns 403", async () => {
    await insertOrphanSet(profileId);

    // Create a node owned by a DIFFERENT user
    const otherNodeId = `${PREFIX}-other-node-${uid()}`;
    await db.execute(sql`
      INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
      VALUES (${otherNodeId}, ${`inst-${uid()}`}, ${'other-user-nobody'}, 'online', 'RTX 4090', 24, 'gpu_poa_challenge', '0.50', 50, 0, 0, '0', 0, now())
    `);

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId: otherNodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    // Worker tries to access attempt belonging to different user's node
    const res = await request(app)
      .get(`/api/compute/challenges/${attemptId}/stage`)
      .set(workerAuth);
    expect(res.status).toBe(403);
  });

  it("RT5e: malformed payload returns 400", async () => {
    const res = await request(app)
      .post("/api/compute/challenges/some-attempt/checkpoint")
      .set(workerAuth)
      .send({ stageIndex: "not-a-number" }); // ZodError
    expect(res.status).toBe(400);
  });
});

describe("Phase 2A Routes — RT6: Ambiguous Retry", () => {
  it("RT6: replay of committed checkpoint produces same result", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    const bundles = await storage.getChallengeBundles(attemptId);
    const sorted = bundles.sort((a, b) => a.stageIndex - b.stageIndex);

    // Submit stage 0
    const b0 = sorted[0];
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);
    const body0 = {
      stageIndex: 0,
      resultDigest: b0.expectedDigest,
      stageNonce: b0.stageNonce,
      transcriptPrevHash: "",
      transcriptEntryHash: entry0,
    };

    const cp1 = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send(body0);
    expect(cp1.status).toBe(200);

    // Submit stage 1
    const b1 = sorted[1];
    const entry1 = computeTranscriptEntryHash(entry0, 1, b1.expectedDigest);
    const body1 = {
      stageIndex: 1,
      resultDigest: b1.expectedDigest,
      stageNonce: b1.stageNonce,
      transcriptPrevHash: entry0,
      transcriptEntryHash: entry1,
    };

    const cp2 = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send(body1);
    expect(cp2.status).toBe(200);

    // Retry stage 0 again (simulating client retry after ambiguous response)
    const cp3 = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send(body0);
    expect(cp3.status).toBe(200);
    expect(cp3.body.checkpointId).toBe(cp1.body.checkpointId); // same checkpoint returned

    // Retry stage 1 again
    const cp4 = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send(body1);
    expect(cp4.status).toBe(200);
    expect(cp4.body.checkpointId).toBe(cp2.body.checkpointId);

    // Only 2 checkpoint rows should exist
    const cps = await storage.getChallengeCheckpoints(attemptId);
    expect(cps).toHaveLength(2);
  });
});

describe("Phase 2A Routes — RT7: Terminal Attempt", () => {
  it("RT7a: checkpoint to timed_out attempt returns 410", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    // Manually set to timed_out
    await db.execute(sql`
      UPDATE compute_job_attempts SET state = 'timed_out' WHERE id = ${attemptId}
    `);

    const bundles = await storage.getChallengeBundles(attemptId);
    const b0 = bundles.find(b => b.stageIndex === 0)!;
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);

    const res = await request(app)
      .post(`/api/compute/challenges/${attemptId}/checkpoint`)
      .set(workerAuth)
      .send({
        stageIndex: 0,
        resultDigest: b0.expectedDigest,
        stageNonce: b0.stageNonce,
        transcriptPrevHash: "",
        transcriptEntryHash: entry0,
      });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("ATTEMPT_TERMINAL");
    expect(res.body.state).toBe("timed_out");
  });

  it("RT7b: stage fetch for accepted attempt returns 410", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    // Manually set to accepted
    await db.execute(sql`
      UPDATE compute_job_attempts SET state = 'accepted' WHERE id = ${attemptId}
    `);

    const res = await request(app)
      .get(`/api/compute/challenges/${attemptId}/stage`)
      .set(workerAuth);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe("ATTEMPT_TERMINAL");
  });

  it("RT7c: status fetch for terminal attempt still works (informational)", async () => {
    await insertOrphanSet(profileId);
    const nodeId = await createWorkerNode();

    const issueRes = await request(app)
      .post("/api/compute/challenges/issue")
      .set(coordAuth)
      .send({ nodeId, profileId });
    expect(issueRes.status).toBe(201);
    const { attemptId } = issueRes.body;

    await db.execute(sql`
      UPDATE compute_job_attempts SET state = 'timed_out', failure_reason = 'STAGE_DEADLINE_MISSED' WHERE id = ${attemptId}
    `);

    const res = await request(app)
      .get(`/api/compute/challenges/${attemptId}/status`)
      .set(workerAuth);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("timed_out");
    expect(res.body.failureReason).toBe("STAGE_DEADLINE_MISSED");
  });
});
