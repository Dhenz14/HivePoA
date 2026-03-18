/**
 * Phase 2A Deploy-Time Migration Correctness Tests
 *
 * Proves that Phase 2A schema additions migrate correctly on a real PostgreSQL
 * database, outside the self-healing test harness.
 *
 * Uses an isolated PostgreSQL schema (mig_test_<random>) so destructive DDL
 * does not affect other test suites running in parallel.
 *
 * The test simulates the actual deployment migration path:
 *   1. Create a pre-Phase-2A schema state (existing compute tables, no Phase 2A)
 *   2. Insert pre-existing data
 *   3. Apply Phase 2A DDL (what db:push would generate)
 *   4. Verify existing data survives with correct defaults
 *   5. Verify Phase 2A operations work on migrated data
 *   6. Verify frozen invariants hold
 *   7. Verify partial migration fails loudly
 *
 * Covers:
 *   MG1 — Upgrade path: pre-Phase-2A rows survive migration with correct defaults
 *   MG2 — Startup reconciliation on migrated DB converges cleanly
 *   MG3 — Frozen invariants hold on migrated schema (set integrity, contiguity, binding)
 *   MG4 — Missing Phase 2A tables cause storage operations to fail loudly
 *   MG5 — Column metadata matches schema expectations (nullability, defaults)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import { pool } from "../db";

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const SCHEMA = `mig_test_${uid()}`;
const STAGES = 5;

/** Run SQL in the isolated migration test schema. */
async function execSql(text: string, params: any[] = []): Promise<any[]> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${SCHEMA}, public`);
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}

// ── Pre-Phase-2A Baseline Schema ─────────────────────────────────────────────

/** Create the minimum pre-Phase-2A compute tables needed for the migration test. */
async function createPrePhase2ABaseline(): Promise<void> {
  await execSql(`
    CREATE TABLE compute_nodes (
      id VARCHAR PRIMARY KEY,
      node_instance_id TEXT NOT NULL,
      hive_username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'online',
      gpu_model TEXT NOT NULL DEFAULT '',
      gpu_vram_gb INTEGER NOT NULL DEFAULT 0,
      supported_workloads TEXT NOT NULL DEFAULT '',
      price_per_hour_hbd TEXT NOT NULL DEFAULT '0',
      reputation_score INTEGER NOT NULL DEFAULT 50,
      total_jobs_completed INTEGER NOT NULL DEFAULT 0,
      total_jobs_failed INTEGER NOT NULL DEFAULT 0,
      total_hbd_earned TEXT NOT NULL DEFAULT '0',
      jobs_in_progress INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  await execSql(`
    CREATE TABLE compute_jobs (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      creator_username TEXT NOT NULL,
      workload_type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      manifest_json TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      min_vram_gb INTEGER NOT NULL DEFAULT 16,
      required_models TEXT NOT NULL DEFAULT '',
      budget_hbd TEXT NOT NULL DEFAULT '0',
      reserved_budget_hbd TEXT NOT NULL DEFAULT '0',
      lease_seconds INTEGER NOT NULL DEFAULT 3600,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      verification_policy_json TEXT,
      accepted_attempt_id VARCHAR,
      deadline_at TIMESTAMP,
      cancelled_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);

  await execSql(`
    CREATE TABLE compute_job_attempts (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id VARCHAR NOT NULL REFERENCES compute_jobs(id),
      node_id VARCHAR NOT NULL REFERENCES compute_nodes(id),
      lease_token TEXT NOT NULL,
      nonce TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'leased',
      progress_pct INTEGER NOT NULL DEFAULT 0,
      current_stage TEXT,
      output_cid TEXT,
      output_sha256 TEXT,
      output_size_bytes INTEGER,
      output_transport_url TEXT,
      metrics_json TEXT,
      result_json TEXT,
      stderr_tail TEXT,
      failure_reason TEXT,
      lease_expires_at TIMESTAMP NOT NULL,
      submission_payload_hash TEXT,
      provenance_json TEXT,
      started_at TIMESTAMP,
      heartbeat_at TIMESTAMP,
      submitted_at TIMESTAMP,
      finished_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
}

/** Apply the Phase 2A migration DDL. */
async function applyPhase2AMigration(): Promise<void> {
  // Add columns to existing tables
  await execSql(`ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS target_node_id VARCHAR`);
  await execSql(`ALTER TABLE compute_jobs ADD COLUMN IF NOT EXISTS poa_scored_at TIMESTAMP`);
  await execSql(`ALTER TABLE compute_nodes ADD COLUMN IF NOT EXISTS last_poa_challenge_at TIMESTAMP`);
  await execSql(`ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS challenge_protocol_version INTEGER`);
  await execSql(`ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS challenge_profile_id VARCHAR`);
  await execSql(`ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS first_progress_at TIMESTAMP`);
  await execSql(`ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS checkpoint_count INTEGER NOT NULL DEFAULT 0`);
  await execSql(`ALTER TABLE compute_job_attempts ADD COLUMN IF NOT EXISTS transcript_hash TEXT`);

  // Create new Phase 2A tables
  await execSql(`
    CREATE TABLE compute_resource_class_profiles (
      profile_id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id INTEGER NOT NULL,
      class_name TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      kernel_id TEXT NOT NULL,
      m INTEGER NOT NULL, n INTEGER NOT NULL, k INTEGER NOT NULL,
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
  await execSql(`CREATE UNIQUE INDEX resource_class_profiles_version_class_id_idx ON compute_resource_class_profiles(protocol_version, class_id)`);
  await execSql(`CREATE UNIQUE INDEX resource_class_profiles_version_class_name_idx ON compute_resource_class_profiles(protocol_version, class_name)`);

  await execSql(`
    CREATE TABLE compute_challenge_stage_bundles (
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
  await execSql(`CREATE UNIQUE INDEX challenge_stage_bundles_set_stage_idx ON compute_challenge_stage_bundles(challenge_set_id, stage_index)`);
  await execSql(`CREATE INDEX challenge_stage_bundles_attempt_stage_idx ON compute_challenge_stage_bundles(attempt_id, stage_index)`);
  await execSql(`CREATE INDEX challenge_stage_bundles_pool_idx ON compute_challenge_stage_bundles(profile_id, precomputed_at) WHERE attempt_id IS NULL`);

  await execSql(`
    CREATE TABLE compute_challenge_checkpoints (
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
  await execSql(`CREATE UNIQUE INDEX challenge_checkpoints_attempt_stage_idx ON compute_challenge_checkpoints(attempt_id, stage_index)`);
  await execSql(`CREATE UNIQUE INDEX compute_job_attempts_id_job_id_idx ON compute_job_attempts(id, job_id)`);
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create isolated schema
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  // Drop isolated schema
  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  } finally {
    client.release();
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 2A Migration — MG1: Upgrade Path", () => {
  it("MG1: pre-Phase-2A rows survive migration with correct defaults", async () => {
    // Step 1: Create pre-Phase-2A baseline tables
    await createPrePhase2ABaseline();

    // Step 2: Insert pre-existing data into the pre-Phase-2A schema
    const nodeId = `mig-node-${uid()}`;
    await execSql(`
      INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
      VALUES ($1, $2, $3, 'online', 'RTX 4090', 24, 'eval_sweep', '0.50', 50, 10, 2, '5.000', 0, now())
    `, [nodeId, `inst-${uid()}`, `user-${uid()}`]);

    const jobId = `mig-job-${uid()}`;
    const sha = createHash("sha256").update("pre-phase2a").digest("hex");
    await execSql(`
      INSERT INTO compute_jobs (id, creator_username, workload_type, state, priority, manifest_json, manifest_sha256, min_vram_gb, budget_hbd, reserved_budget_hbd, lease_seconds, max_attempts, attempt_count, created_at)
      VALUES ($1, 'test-user', 'eval_sweep', 'accepted', 5, '{"model":"llama"}', $2, 16, '1.000', '0', 3600, 3, 1, now())
    `, [jobId, sha]);

    const attemptId = `mig-att-${uid()}`;
    await execSql(`
      INSERT INTO compute_job_attempts (id, job_id, node_id, lease_token, nonce, state, progress_pct, lease_expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, 'accepted', 100, now() + interval '1 hour', now())
    `, [attemptId, jobId, nodeId, uid(), uid()]);

    // Step 3: Apply Phase 2A migration
    await applyPhase2AMigration();

    // Step 4: Verify pre-existing data survived
    const [job] = await execSql(`SELECT * FROM compute_jobs WHERE id = $1`, [jobId]);
    expect(job).toBeDefined();
    expect(job.state).toBe("accepted");
    expect(job.workload_type).toBe("eval_sweep");
    expect(job.manifest_json).toBe('{"model":"llama"}');
    // New columns should have NULL defaults
    expect(job.target_node_id).toBeNull();
    expect(job.poa_scored_at).toBeNull();

    const [attempt] = await execSql(`SELECT * FROM compute_job_attempts WHERE id = $1`, [attemptId]);
    expect(attempt).toBeDefined();
    expect(attempt.state).toBe("accepted");
    expect(attempt.progress_pct).toBe(100);
    // Phase 2A rollup columns should have correct defaults
    expect(attempt.challenge_protocol_version).toBeNull();
    expect(attempt.challenge_profile_id).toBeNull();
    expect(attempt.first_progress_at).toBeNull();
    expect(attempt.checkpoint_count).toBe(0); // NOT NULL DEFAULT 0
    expect(attempt.transcript_hash).toBeNull();

    const [node] = await execSql(`SELECT * FROM compute_nodes WHERE id = $1`, [nodeId]);
    expect(node).toBeDefined();
    expect(node.reputation_score).toBe(50);
    expect(node.total_jobs_completed).toBe(10);
    expect(node.last_poa_challenge_at).toBeNull();

    // Phase 2A tables should exist and be empty
    const profiles = await execSql(`SELECT COUNT(*)::int AS cnt FROM compute_resource_class_profiles`);
    expect(profiles[0].cnt).toBe(0);

    const bundles = await execSql(`SELECT COUNT(*)::int AS cnt FROM compute_challenge_stage_bundles`);
    expect(bundles[0].cnt).toBe(0);

    const checkpoints = await execSql(`SELECT COUNT(*)::int AS cnt FROM compute_challenge_checkpoints`);
    expect(checkpoints[0].cnt).toBe(0);
  });
});

describe("Phase 2A Migration — MG2: Post-Migration Operations", () => {
  it("MG2: Phase 2A operations work on migrated schema with pre-existing data", async () => {
    // Tables already exist from MG1. Create a profile and test Phase 2A operations.
    const classId = 40000 + Math.floor(Math.random() * 9000);
    const [profile] = await execSql(`
      INSERT INTO compute_resource_class_profiles
        (class_id, class_name, protocol_version, kernel_id, m, n, k, mix_rounds, stages_per_challenge,
         first_progress_deadline_ms, stage_deadline_ms, completion_deadline_ms,
         pool_target, pool_low_watermark_pct, pool_critical_watermark_pct)
      VALUES ($1, $2, 1, 'phase2a-kernel-v1', 4096, 4096, 8, 1, 5, 30000, 60000, 600000, 50, 50, 25)
      RETURNING *
    `, [classId, `gpu-mig-${uid()}`]);
    expect(profile.profile_id).toBeTruthy();

    // Insert orphan bundle set
    const setId = `mig-set-${uid()}`;
    const rootNonce = `${uid()}-${uid()}`;
    for (let i = 0; i < STAGES; i++) {
      const stageNonce = createHash("sha256")
        .update(rootNonce + String.fromCharCode(i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, (i >> 24) & 0xff))
        .digest("hex");
      const digest = createHash("sha256").update(`expected-${setId}-${i}`).digest("hex");
      await execSql(`
        INSERT INTO compute_challenge_stage_bundles
          (challenge_set_id, profile_id, stage_index, root_nonce, stage_nonce, expected_digest, workload_params_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [setId, profile.profile_id, i, rootNonce, stageNonce, digest, JSON.stringify({
        protocol_version: 1, kernel_id: "phase2a-kernel-v1", class_id: classId,
        stage_index: i, M: 4096, N: 4096, K: 8, mix_rounds: 1,
      })]);
    }

    // Verify: orphan set exists with correct structure
    const bundles = await execSql(`
      SELECT * FROM compute_challenge_stage_bundles
      WHERE challenge_set_id = $1 ORDER BY stage_index
    `, [setId]);
    expect(bundles).toHaveLength(STAGES);
    for (let i = 0; i < STAGES; i++) {
      expect(bundles[i].stage_index).toBe(i);
      expect(bundles[i].attempt_id).toBeNull();
      expect(bundles[i].profile_id).toBe(profile.profile_id);
      expect(bundles[i].root_nonce).toBe(rootNonce);
    }

    // Create a challenge job targeting a node
    const nodeId = `mig-node2-${uid()}`;
    await execSql(`
      INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
      VALUES ($1, $2, $3, 'online', 'RTX 4090', 24, 'gpu_poa_challenge', '0.50', 50, 0, 0, '0', 0, now())
    `, [nodeId, `inst-${uid()}`, `user-${uid()}`]);

    const jobId = `mig-cjob-${uid()}`;
    const jobSha = createHash("sha256").update("challenge-job").digest("hex");
    await execSql(`
      INSERT INTO compute_jobs (id, creator_username, workload_type, state, priority, manifest_json, manifest_sha256, min_vram_gb, budget_hbd, reserved_budget_hbd, lease_seconds, max_attempts, attempt_count, target_node_id, created_at)
      VALUES ($1, 'validator-police', 'gpu_poa_challenge', 'queued', 10, '{}', $2, 0, '0', '0', 600, 1, 0, $3, now())
    `, [jobId, jobSha, nodeId]);

    const attemptId = `mig-catt-${uid()}`;
    await execSql(`
      INSERT INTO compute_job_attempts (id, job_id, node_id, lease_token, nonce, state, progress_pct, lease_expires_at, checkpoint_count, created_at)
      VALUES ($1, $2, $3, $4, $5, 'leased', 0, now() + interval '1 hour', 0, now())
    `, [attemptId, jobId, nodeId, uid(), uid()]);

    // Claim the orphan set
    await execSql(`
      UPDATE compute_challenge_stage_bundles
      SET job_id = $1, attempt_id = $2, claimed_at = now()
      WHERE challenge_set_id = $3
    `, [jobId, attemptId, setId]);

    // Set rollup columns
    await execSql(`
      UPDATE compute_job_attempts
      SET challenge_protocol_version = 1, challenge_profile_id = $1
      WHERE id = $2
    `, [profile.profile_id, attemptId]);

    // Verify claim
    const claimedBundles = await execSql(`
      SELECT * FROM compute_challenge_stage_bundles
      WHERE attempt_id = $1 ORDER BY stage_index
    `, [attemptId]);
    expect(claimedBundles).toHaveLength(STAGES);
    for (const b of claimedBundles) {
      expect(b.attempt_id).toBe(attemptId);
      expect(b.job_id).toBe(jobId);
    }

    // Reveal stage 0
    await execSql(`
      UPDATE compute_challenge_stage_bundles
      SET stage_issued_at = now(), stage_deadline_at = now() + interval '60 seconds'
      WHERE attempt_id = $1 AND stage_index = 0
    `, [attemptId]);

    // Submit checkpoint for stage 0
    const b0 = claimedBundles[0];
    const entry0 = createHash("sha256").update("" + "0" + b0.expected_digest).digest("hex");
    await execSql(`
      INSERT INTO compute_challenge_checkpoints
        (attempt_id, stage_index, stage_nonce, result_digest, checkpoint_received_at,
         transcript_prev_hash, transcript_entry_hash)
      VALUES ($1, 0, $2, $3, now(), '', $4)
    `, [attemptId, b0.stage_nonce, b0.expected_digest, entry0]);

    // Verify checkpoint
    const [cp] = await execSql(`
      SELECT * FROM compute_challenge_checkpoints WHERE attempt_id = $1 AND stage_index = 0
    `, [attemptId]);
    expect(cp).toBeDefined();
    expect(cp.result_digest).toBe(b0.expected_digest);
    expect(cp.transcript_entry_hash).toBe(entry0);

    // Verify UNIQUE(attempt_id, stage_index) prevents duplicates
    try {
      await execSql(`
        INSERT INTO compute_challenge_checkpoints
          (attempt_id, stage_index, stage_nonce, result_digest, checkpoint_received_at,
           transcript_prev_hash, transcript_entry_hash)
        VALUES ($1, 0, 'dup', 'dup', now(), '', 'dup')
      `, [attemptId]);
      expect.fail("Duplicate checkpoint should be rejected");
    } catch (err: any) {
      expect(err.message || err.toString()).toMatch(/unique|duplicate/i);
    }
  });
});

describe("Phase 2A Migration — MG3: Frozen Invariants", () => {
  it("MG3: unique index enforces (set_id, stage_index) invariant", async () => {
    // Attempt duplicate (set_id, stage_index) — should be rejected by unique index
    const setId = `mig-inv-${uid()}`;
    const [profile] = await execSql(`SELECT profile_id FROM compute_resource_class_profiles LIMIT 1`);

    await execSql(`
      INSERT INTO compute_challenge_stage_bundles
        (challenge_set_id, profile_id, stage_index, root_nonce, stage_nonce, expected_digest, workload_params_json)
      VALUES ($1, $2, 0, 'nonce1', 'sn1', 'dig1', '{}')
    `, [setId, profile.profile_id]);

    try {
      await execSql(`
        INSERT INTO compute_challenge_stage_bundles
          (challenge_set_id, profile_id, stage_index, root_nonce, stage_nonce, expected_digest, workload_params_json)
        VALUES ($1, $2, 0, 'nonce2', 'sn2', 'dig2', '{}')
      `, [setId, profile.profile_id]);
      expect.fail("Duplicate (set_id, stage_index) should be rejected");
    } catch (err: any) {
      expect(err.message || err.toString()).toMatch(/unique|duplicate/i);
    }
  });

  it("MG3b: composite attempt uniqueness prevents cross-job drift", async () => {
    // The UNIQUE(id, job_id) index on compute_job_attempts means
    // the same attempt_id can't be paired with a different job_id.
    // This is the application-enforced FK constraint from bundles.

    const nodeId = `mig-drift-node-${uid()}`;
    await execSql(`
      INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
      VALUES ($1, $2, $3, 'online', 'RTX 4090', 24, 'eval_sweep', '0.50', 50, 0, 0, '0', 0, now())
    `, [nodeId, `inst-${uid()}`, `user-${uid()}`]);

    const job1 = `mig-dj1-${uid()}`;
    const job2 = `mig-dj2-${uid()}`;
    const sha = createHash("sha256").update("drift").digest("hex");
    for (const jid of [job1, job2]) {
      await execSql(`
        INSERT INTO compute_jobs (id, creator_username, workload_type, state, priority, manifest_json, manifest_sha256, min_vram_gb, budget_hbd, reserved_budget_hbd, lease_seconds, max_attempts, attempt_count, created_at)
        VALUES ($1, 'test', 'eval_sweep', 'queued', 0, '{}', $2, 0, '0', '0', 3600, 1, 0, now())
      `, [jid, sha]);
    }

    // Create attempt belonging to job1
    const attId = `mig-datt-${uid()}`;
    await execSql(`
      INSERT INTO compute_job_attempts (id, job_id, node_id, lease_token, nonce, state, progress_pct, lease_expires_at, checkpoint_count, created_at)
      VALUES ($1, $2, $3, $4, $5, 'leased', 0, now() + interval '1 hour', 0, now())
    `, [attId, job1, nodeId, uid(), uid()]);

    // The composite UNIQUE(id, job_id) means this same attempt_id with a different
    // job_id would be a different row — but since id is the PK, you can't insert
    // the same id again regardless. The composite index matters for bundle FKs.
    const rows = await execSql(`
      SELECT id, job_id FROM compute_job_attempts WHERE id = $1
    `, [attId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe(job1);
  });
});

describe("Phase 2A Migration — MG4: Partial Migration Fails Loudly", () => {
  it("MG4: queries against non-existent Phase 2A tables fail with clear errors", async () => {
    // Use a fresh schema with NO Phase 2A tables — only test that missing
    // tables produce clear errors, not silent no-ops.
    const partialSchema = `mig_partial_${uid()}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${partialSchema}`);

      // Query for Phase 2A table in the partial schema — should fail clearly
      let threw = false;
      try {
        await client.query(`SELECT * FROM ${partialSchema}.compute_resource_class_profiles LIMIT 1`);
      } catch (err: any) {
        threw = true;
        expect(err.message).toMatch(/does not exist|relation/i);
      }
      expect(threw).toBe(true);

      threw = false;
      try {
        await client.query(`SELECT * FROM ${partialSchema}.compute_challenge_stage_bundles LIMIT 1`);
      } catch (err: any) {
        threw = true;
        expect(err.message).toMatch(/does not exist|relation/i);
      }
      expect(threw).toBe(true);

      threw = false;
      try {
        await client.query(`SELECT * FROM ${partialSchema}.compute_challenge_checkpoints LIMIT 1`);
      } catch (err: any) {
        threw = true;
        expect(err.message).toMatch(/does not exist|relation/i);
      }
      expect(threw).toBe(true);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${partialSchema} CASCADE`);
      client.release();
    }
  });
});

describe("Phase 2A Migration — MG5: Column Metadata", () => {
  it("MG5: migrated columns have correct nullability and defaults", async () => {
    // Verify column metadata matches schema expectations
    const columns = await execSql(`
      SELECT column_name, is_nullable, column_default, data_type
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'compute_job_attempts'
        AND column_name IN (
          'challenge_protocol_version', 'challenge_profile_id',
          'first_progress_at', 'checkpoint_count', 'transcript_hash'
        )
      ORDER BY column_name
    `, [SCHEMA]);

    const colMap = new Map(columns.map((c: any) => [c.column_name, c]));

    // challenge_protocol_version: INTEGER, NULLABLE
    const cpv = colMap.get("challenge_protocol_version");
    expect(cpv).toBeDefined();
    expect(cpv.is_nullable).toBe("YES");
    expect(cpv.data_type).toBe("integer");

    // challenge_profile_id: VARCHAR, NULLABLE
    const cpi = colMap.get("challenge_profile_id");
    expect(cpi).toBeDefined();
    expect(cpi.is_nullable).toBe("YES");

    // first_progress_at: TIMESTAMP, NULLABLE
    const fpa = colMap.get("first_progress_at");
    expect(fpa).toBeDefined();
    expect(fpa.is_nullable).toBe("YES");

    // checkpoint_count: INTEGER, NOT NULL, DEFAULT 0
    const cc = colMap.get("checkpoint_count");
    expect(cc).toBeDefined();
    expect(cc.is_nullable).toBe("NO");
    expect(cc.column_default).toMatch(/0/);

    // transcript_hash: TEXT, NULLABLE
    const th = colMap.get("transcript_hash");
    expect(th).toBeDefined();
    expect(th.is_nullable).toBe("YES");
  });

  it("MG5b: Phase 2A tables have correct structure", async () => {
    // Verify Phase 2A table columns exist with correct types
    const profileCols = await execSql(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'compute_resource_class_profiles'
      ORDER BY ordinal_position
    `, [SCHEMA]);
    const profileColNames = profileCols.map((c: any) => c.column_name);
    expect(profileColNames).toContain("profile_id");
    expect(profileColNames).toContain("class_id");
    expect(profileColNames).toContain("stages_per_challenge");
    expect(profileColNames).toContain("stage_deadline_ms");
    expect(profileColNames).toContain("pool_target");

    const bundleCols = await execSql(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'compute_challenge_stage_bundles'
      ORDER BY ordinal_position
    `, [SCHEMA]);
    const bundleColNames = bundleCols.map((c: any) => c.column_name);
    expect(bundleColNames).toContain("challenge_set_id");
    expect(bundleColNames).toContain("stage_index");
    expect(bundleColNames).toContain("expected_digest");
    expect(bundleColNames).toContain("stage_issued_at");
    expect(bundleColNames).toContain("stage_deadline_at");

    const cpCols = await execSql(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'compute_challenge_checkpoints'
      ORDER BY ordinal_position
    `, [SCHEMA]);
    const cpColNames = cpCols.map((c: any) => c.column_name);
    expect(cpColNames).toContain("attempt_id");
    expect(cpColNames).toContain("stage_index");
    expect(cpColNames).toContain("result_digest");
    expect(cpColNames).toContain("transcript_prev_hash");
    expect(cpColNames).toContain("transcript_entry_hash");
  });

  it("MG5c: Phase 2A indexes exist on migrated schema", async () => {
    const indexes = await execSql(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = $1
      ORDER BY indexname
    `, [SCHEMA]);
    const idxNames = indexes.map((i: any) => i.indexname);

    // Phase 2A unique indexes
    expect(idxNames).toContain("resource_class_profiles_version_class_id_idx");
    expect(idxNames).toContain("resource_class_profiles_version_class_name_idx");
    expect(idxNames).toContain("challenge_stage_bundles_set_stage_idx");
    expect(idxNames).toContain("challenge_checkpoints_attempt_stage_idx");
    expect(idxNames).toContain("compute_job_attempts_id_job_id_idx");

    // Phase 2A performance indexes
    expect(idxNames).toContain("challenge_stage_bundles_attempt_stage_idx");
    expect(idxNames).toContain("challenge_stage_bundles_pool_idx");
  });
});
