#!/usr/bin/env npx tsx
/**
 * Phase 1: Cold-Restart E2E Tests — AS-1 and AS-2
 *
 * Real process death after server accept, then cold recovery using only
 * persisted DB state and durable events. No in-process reconstruction,
 * no hidden state, no interpretive shortcuts.
 *
 * AS-1: Server accepted, response lost, worker retries
 *   → idempotent cached result, no double payout
 *
 * AS-2: Settlement committed, ack lost, coordinator retries
 *   → payout already queued, no duplicate transitions
 *
 * Reconstruction: computeJobs + computeJobAttempts + computePayouts +
 * computeVerifications tables ONLY. Nothing else.
 *
 * Run: npx tsx tests/cold-restart-e2e.ts
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ================================================================
// Configuration
// ================================================================
const PORT = 3096;
const BASE_URL = `http://localhost:${PORT}`;
const DB_URL = "postgresql://postgres@localhost:5432/hivepoa";
const TEST_PREFIX = `cold-e2e-${Date.now()}`;
const BEARER_TOKEN = "canary-test-token-2026";
const AGENT_API_KEY = `test-agent-key-${TEST_PREFIX}`;
const TEST_USERNAME = "cold-restart-tester";
const NODE_INSTANCE_ID = `test-node-${TEST_PREFIX}`;

// Read freeze file for evidence
const FREEZE_PATH = join(__dirname, "../docs/CONTRACT_FREEZE.json");
const FREEZE = JSON.parse(readFileSync(FREEZE_PATH, "utf8"));

const pool = new pg.Pool({ connectionString: DB_URL });

// ================================================================
// Evidence structures
// ================================================================
interface ColdRestartEvidence {
  scenario_id: string;
  scenario_name: string;
  hivepoa_sha: string;
  hiveai_sha: string;
  server_kills: number;
  cold_restarts: number;
  db_reconstruction: {
    jobs: Record<string, unknown>[];
    attempts: Record<string, unknown>[];
    payouts: Record<string, unknown>[];
    verifications: Record<string, unknown>[];
  };
  assertions: Record<string, boolean>;
  timeline: Array<{ t: string; event: string; detail?: string }>;
  pass: boolean;
}

function ts(): string {
  return new Date().toISOString();
}

// ================================================================
// Server lifecycle manager
// ================================================================
class ServerProcess {
  private proc: ChildProcess | null = null;
  private stdout = "";
  private stderr = "";

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server start timeout (30s)")), 30_000);

      this.proc = spawn("npx", ["tsx", "server/index.ts"], {
        cwd: join(__dirname, ".."),
        env: {
          ...process.env,
          PORT: String(PORT),
          NODE_ENV: "production",
          DATABASE_URL: DB_URL,
          SKIP_IPFS: "true", // Skip IPFS daemon — not needed for protocol tests
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });

      this.proc.stdout?.on("data", (d) => {
        this.stdout += d.toString();
        // Detect server ready
        if (this.stdout.includes(`serving on port ${PORT}`)) {
          clearTimeout(timeout);
          // Give routes 500ms to finish registering
          setTimeout(() => resolve(), 500);
        }
      });

      this.proc.stderr?.on("data", (d) => {
        this.stderr += d.toString();
      });

      this.proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.proc.on("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          // Don't reject if we killed it intentionally
        }
      });
    });
  }

  kill(): void {
    if (!this.proc?.pid) return;
    try {
      // On Windows, use taskkill to kill the entire process tree
      execSync(`taskkill /F /T /PID ${this.proc.pid}`, { stdio: "ignore" });
    } catch {
      // Process may have already exited
      try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
    this.proc = null;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}

// ================================================================
// DB forensic queries (reconstruction from persisted state ONLY)
// ================================================================
async function getJobFromDB(jobId: string) {
  const { rows } = await pool.query(
    `SELECT id, state, accepted_attempt_id, budget_hbd, attempt_count, workload_type,
            created_at, completed_at
     FROM compute_jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0] || null;
}

async function getAttemptsFromDB(jobId: string) {
  const { rows } = await pool.query(
    `SELECT id, job_id, node_id, nonce, state, lease_token,
            submission_payload_hash, output_sha256, output_cid,
            submitted_at, finished_at, failure_reason
     FROM compute_job_attempts WHERE job_id = $1 ORDER BY created_at`,
    [jobId],
  );
  return rows;
}

async function getPayoutsFromDB(jobId: string) {
  const { rows } = await pool.query(
    `SELECT id, job_id, attempt_id, node_id, amount_hbd, reason, status, treasury_tx_id
     FROM compute_payouts WHERE job_id = $1 ORDER BY created_at`,
    [jobId],
  );
  return rows;
}

async function getVerificationsFromDB(jobId: string) {
  const { rows } = await pool.query(
    `SELECT id, job_id, attempt_id, verifier_type, result, score
     FROM compute_verifications WHERE job_id = $1 ORDER BY created_at`,
    [jobId],
  );
  return rows;
}

async function waitForAttemptState(attemptId: string, targetStates: string[], timeoutMs = 15_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT state FROM compute_job_attempts WHERE id = $1`,
      [attemptId],
    );
    if (rows[0] && targetStates.includes(rows[0].state)) {
      return rows[0].state;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for attempt ${attemptId} to reach ${targetStates.join("|")}`);
}

async function waitForPayoutStatus(jobId: string, targetStatus: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT status FROM compute_payouts WHERE job_id = $1`,
      [jobId],
    );
    if (rows.length > 0 && rows.some((r: any) => r.status === targetStatus)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for payouts on job ${jobId} to reach ${targetStatus}`);
}

// ================================================================
// HTTP client helpers
// ================================================================
async function apiCall(
  method: string,
  path: string,
  body: unknown,
  auth: { type: "bearer" | "apikey"; token: string },
  signal?: AbortSignal,
): Promise<{ status: number; data: any }> {
  const authHeader = auth.type === "bearer"
    ? `Bearer ${auth.token}`
    : `ApiKey ${auth.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const bearer = { type: "bearer" as const, token: BEARER_TOKEN };
const apikey = { type: "apikey" as const, token: AGENT_API_KEY };

// ================================================================
// DB seeding (auth rows that survive server restarts)
// ================================================================
async function seedAuth(): Promise<void> {
  // Read existing session username for this token (if exists)
  const { rows: existing } = await pool.query(
    `SELECT username FROM user_sessions WHERE token = $1`,
    [BEARER_TOKEN],
  );

  let username: string;
  if (existing.length > 0) {
    // Use the existing session's username to avoid ownership mismatch
    username = existing[0].username;
    // Extend expiry
    await pool.query(
      `UPDATE user_sessions SET expires_at = $1 WHERE token = $2`,
      [new Date("2027-01-01"), BEARER_TOKEN],
    );
  } else {
    // Create new session
    username = TEST_USERNAME;
    await pool.query(
      `INSERT INTO user_sessions (token, username, role, expires_at)
       VALUES ($1, $2, 'user', $3)`,
      [BEARER_TOKEN, username, new Date("2027-01-01")],
    );
  }

  // Ensure agent API key exists with SAME username as the session
  await pool.query(
    `INSERT INTO agent_keys (id, api_key, hive_username)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET api_key = $2, hive_username = $3`,
    [`agent-${TEST_PREFIX}`, AGENT_API_KEY, username],
  );

  console.log(`[setup] Auth seeded: user=${username}, bearer=${BEARER_TOKEN}, apikey=${AGENT_API_KEY}`);
}

// ================================================================
// Evidence emission
// ================================================================
function emitEvidence(evidence: ColdRestartEvidence): void {
  const dir = join(__dirname, "../evidence/cold-restart");
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  writeFileSync(
    join(dir, `${evidence.scenario_id}.json`),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(`[evidence] Written: evidence/cold-restart/${evidence.scenario_id}.json`);
}

// ================================================================
// AS-1: Server accepted, response lost, worker retries
// ================================================================
async function runAS1(): Promise<ColdRestartEvidence> {
  console.log("\n========================================");
  console.log("AS-1: Server accepted, response lost, worker retries");
  console.log("========================================\n");

  const timeline: ColdRestartEvidence["timeline"] = [];
  let serverKills = 0;
  let coldRestarts = 0;

  // --- Phase A: Setup and execute through DB commit ---
  const server1 = new ServerProcess();
  console.log("[AS-1] Starting server-1...");
  await server1.start();
  coldRestarts++;
  timeline.push({ t: ts(), event: "server_1_started" });
  console.log("[AS-1] Server-1 ready on port", PORT);

  // Register node
  const regRes = await apiCall("POST", "/api/compute/nodes/register", {
    nodeInstanceId: NODE_INSTANCE_ID,
    gpuModel: "RTX 4090",
    gpuVramGb: 24,
    supportedWorkloads: "eval_sweep,benchmark_run",
    cachedModels: "none",
  }, bearer);
  console.log("[AS-1] Node registered:", regRes.status);
  timeline.push({ t: ts(), event: "node_registered", detail: `status=${regRes.status}` });

  // Create job
  const jobRes = await apiCall("POST", "/api/compute/jobs", {
    workloadType: "eval_sweep",
    manifest: {
      schema_version: 1,
      workload_type: "eval_sweep",
      executor_type: "eval",
      executor_version: "1.0.0",
    },
    budgetHbd: "0.300",
    leaseSeconds: 3600,
    maxAttempts: 3,
  }, bearer);
  console.log("[AS-1] Job create response:", jobRes.status, JSON.stringify(jobRes.data)?.slice(0, 200));
  if (jobRes.status !== 201 || !jobRes.data?.id) {
    throw new Error(`Job creation failed: ${jobRes.status} ${JSON.stringify(jobRes.data)}`);
  }
  const jobId = jobRes.data.id;
  console.log("[AS-1] Job created:", jobId);
  timeline.push({ t: ts(), event: "job_created", detail: jobId });

  // Claim job (get nonce) — use the claimed job's ID, not our created job's ID
  // because claimNextJob picks any queued job (there may be stale ones)
  const claimRes = await apiCall("POST", "/api/compute/jobs/claim-next", {
    nodeInstanceId: NODE_INSTANCE_ID,
  }, apikey);
  console.log("[AS-1] Claim response:", claimRes.status, claimRes.data?.job ? "got job" : "no job", claimRes.data?.error || "");
  if (!claimRes.data?.attempt) {
    throw new Error(`Claim failed: ${JSON.stringify(claimRes.data)}`);
  }
  // IMPORTANT: Use the claimed job's actual ID — may differ from jobId if stale jobs exist
  const claimedJobId = claimRes.data.job.id;
  if (claimedJobId !== jobId) {
    console.log(`[AS-1] WARNING: claimed job ${claimedJobId.slice(0, 8)} differs from created ${jobId.slice(0, 8)} — using claimed ID`);
  }
  const { attempt } = claimRes.data;
  const attemptId = attempt.id;
  const leaseToken = attempt.leaseToken;
  const nonce = attempt.nonce;
  console.log("[AS-1] Job claimed: job=%s attempt=%s nonce=%s", claimedJobId.slice(0, 8), attemptId, nonce);
  timeline.push({ t: ts(), event: "job_claimed", detail: `job=${claimedJobId} attempt=${attemptId} nonce=${nonce}` });

  // Start job
  await apiCall("POST", `/api/compute/jobs/${claimedJobId}/start`, {
    attemptId, leaseToken,
  }, apikey);
  timeline.push({ t: ts(), event: "job_started" });

  // Submit result — fire and DON'T await, poll DB instead
  const outputSha256 = "a".repeat(64);
  const resultJson = JSON.stringify({ scores: { python: 0.95, rust: 0.92 }, score: 0.935 });
  const submitBody = {
    attemptId,
    leaseToken,
    nonce,
    outputCid: "QmColdRestartTestCid",
    outputSha256,
    resultJson,
  };

  console.log("[AS-1] Submitting result (fire-and-forget)...");
  const abortCtrl = new AbortController();
  const submitPromise = apiCall("POST", `/api/compute/jobs/${claimedJobId}/submit`, submitBody, apikey, abortCtrl.signal)
    .catch(() => null); // Will fail when we kill the server

  // Poll DB for accepted state AND payouts (payouts created after state="accepted")
  timeline.push({ t: ts(), event: "submit_sent_polling_db" });
  const reachedState = await waitForAttemptState(attemptId, ["accepted", "rejected"]);
  console.log("[AS-1] DB shows attempt state:", reachedState);
  timeline.push({ t: ts(), event: "db_shows_accepted", detail: reachedState });

  // Wait briefly for payouts to be created (they follow the state change)
  await new Promise((r) => setTimeout(r, 200));
  const payoutsBefore = await getPayoutsFromDB(claimedJobId);
  console.log("[AS-1] Payouts in DB before kill:", payoutsBefore.length);
  timeline.push({ t: ts(), event: "payouts_confirmed_in_db", detail: `count=${payoutsBefore.length}` });

  // SIGKILL server-1 — response never reaches client
  console.log("[AS-1] KILLING server-1 (SIGKILL)...");
  server1.kill();
  abortCtrl.abort();
  serverKills++;
  timeline.push({ t: ts(), event: "server_1_killed" });

  // Brief pause for process cleanup
  await new Promise((r) => setTimeout(r, 2000));

  // --- Phase B: Cold restart and retry ---
  const server2 = new ServerProcess();
  console.log("[AS-1] Starting server-2 (cold restart)...");
  await server2.start();
  coldRestarts++;
  timeline.push({ t: ts(), event: "server_2_started_cold" });
  console.log("[AS-1] Server-2 ready");

  // Retry the EXACT SAME submit (same attemptId, leaseToken, nonce, payload)
  console.log("[AS-1] Retrying submit with same nonce + payload...");
  const retryRes = await apiCall("POST", `/api/compute/jobs/${claimedJobId}/submit`, submitBody, apikey);
  console.log("[AS-1] Retry response: status=%d state=%s", retryRes.status, retryRes.data?.state);
  timeline.push({ t: ts(), event: "retry_submit_response", detail: `status=${retryRes.status} state=${retryRes.data?.state}` });

  // --- Phase C: Forensic reconstruction from DB only ---
  console.log("[AS-1] Forensic reconstruction from DB...");
  const job = await getJobFromDB(claimedJobId);
  const attempts = await getAttemptsFromDB(claimedJobId);
  const payouts = await getPayoutsFromDB(claimedJobId);
  const verifications = await getVerificationsFromDB(claimedJobId);

  // Kill server-2
  server2.kill();
  timeline.push({ t: ts(), event: "server_2_stopped" });

  // Assert invariants
  const assertions: Record<string, boolean> = {
    retry_returned_200: retryRes.status === 200,
    retry_state_is_accepted: retryRes.data?.state === "accepted",
    job_state_accepted: job?.state === "accepted",
    exactly_one_attempt: attempts.length === 1,
    attempt_state_accepted: attempts[0]?.state === "accepted",
    submission_payload_hash_set: !!attempts[0]?.submission_payload_hash,
    exactly_three_payouts: payouts.length === 3,
    no_duplicate_payouts: new Set(payouts.map((p: any) => p.reason)).size === payouts.length,
    all_payouts_pending: payouts.every((p: any) => p.status === "pending"),
    two_verification_passes: verifications.length === 2 && verifications.every((v: any) => v.result === "pass"),
    accepted_attempt_id_matches: job?.accepted_attempt_id === attemptId,
    nonce_preserved: attempts[0]?.nonce === nonce,
  };

  const allPass = Object.values(assertions).every(Boolean);

  console.log("\n[AS-1] Assertions:");
  for (const [k, v] of Object.entries(assertions)) {
    console.log(`  ${v ? "PASS" : "FAIL"}: ${k}`);
  }
  console.log(`\n[AS-1] ${allPass ? "ALL PASS" : "SOME FAILED"}`);

  const evidence: ColdRestartEvidence = {
    scenario_id: "AS-1-cold",
    scenario_name: "Server accepted, response lost, worker retries → cold restart → idempotent cached result",
    hivepoa_sha: FREEZE.three_layer_sha_model?.frozen_bilateral_pair?.hivepoa || FREEZE.sha_pair?.hivepoa || "unknown",
    hiveai_sha: FREEZE.three_layer_sha_model?.frozen_bilateral_pair?.hiveai || FREEZE.sha_pair?.hiveai || "unknown",
    server_kills: serverKills,
    cold_restarts: coldRestarts,
    db_reconstruction: {
      jobs: [job],
      attempts,
      payouts,
      verifications,
    },
    assertions,
    timeline,
    pass: allPass,
  };

  emitEvidence(evidence);
  return evidence;
}

// ================================================================
// AS-2: Settlement committed, ack lost, coordinator retries
// ================================================================
async function runAS2(jobId: string, attemptId: string): Promise<ColdRestartEvidence> {
  console.log("\n========================================");
  console.log("AS-2: Settlement committed, ack lost, coordinator retries");
  console.log("========================================\n");

  const timeline: ColdRestartEvidence["timeline"] = [];
  let serverKills = 0;
  let coldRestarts = 0;

  // --- Phase D: Settle with kill ---
  const server3 = new ServerProcess();
  console.log("[AS-2] Starting server-3...");
  await server3.start();
  coldRestarts++;
  timeline.push({ t: ts(), event: "server_3_started" });

  // Fire settle and DON'T await
  console.log("[AS-2] Settling payouts (fire-and-forget)...");
  const abortCtrl = new AbortController();
  const settlePromise = apiCall("POST", `/api/compute/jobs/${jobId}/settle`, {}, bearer, abortCtrl.signal)
    .catch(() => null);

  // Poll DB for payout status transition
  timeline.push({ t: ts(), event: "settle_sent_polling_db" });
  await waitForPayoutStatus(jobId, "queued");
  console.log("[AS-2] DB shows payouts queued");
  timeline.push({ t: ts(), event: "db_shows_payouts_queued" });

  // SIGKILL server-3
  console.log("[AS-2] KILLING server-3 (SIGKILL)...");
  server3.kill();
  abortCtrl.abort();
  serverKills++;
  timeline.push({ t: ts(), event: "server_3_killed" });

  await new Promise((r) => setTimeout(r, 2000));

  // --- Phase E: Cold restart and retry ---
  const server4 = new ServerProcess();
  console.log("[AS-2] Starting server-4 (cold restart)...");
  await server4.start();
  coldRestarts++;
  timeline.push({ t: ts(), event: "server_4_started_cold" });

  // Retry settlement
  console.log("[AS-2] Retrying settlement...");
  const retryRes = await apiCall("POST", `/api/compute/jobs/${jobId}/settle`, {}, bearer);
  console.log("[AS-2] Retry response: status=%d settled=%d", retryRes.status, retryRes.data?.settled);
  timeline.push({ t: ts(), event: "retry_settle_response", detail: `status=${retryRes.status} settled=${retryRes.data?.settled}` });

  // --- Phase F: Final forensic reconstruction ---
  console.log("[AS-2] Forensic reconstruction from DB...");
  const job = await getJobFromDB(jobId);
  const attempts = await getAttemptsFromDB(jobId);
  const payouts = await getPayoutsFromDB(jobId);
  const verifications = await getVerificationsFromDB(jobId);

  server4.kill();
  timeline.push({ t: ts(), event: "server_4_stopped" });

  // Assert invariants
  const assertions: Record<string, boolean> = {
    retry_returned_200: retryRes.status === 200,
    retry_settled_zero: retryRes.data?.settled === 0, // all already queued, none pending
    exactly_three_payouts: payouts.length === 3,
    no_duplicate_payouts: new Set(payouts.map((p: any) => p.id)).size === payouts.length,
    all_payouts_queued: payouts.every((p: any) => p.status === "queued"),
    job_state_still_accepted: job?.state === "accepted", // settle only moves payouts, not job state
    exactly_one_attempt: attempts.length === 1,
    attempt_state_accepted: attempts[0]?.state === "accepted",
    accepted_attempt_id_matches: job?.accepted_attempt_id === attemptId,
  };

  const allPass = Object.values(assertions).every(Boolean);

  console.log("\n[AS-2] Assertions:");
  for (const [k, v] of Object.entries(assertions)) {
    console.log(`  ${v ? "PASS" : "FAIL"}: ${k}`);
  }
  console.log(`\n[AS-2] ${allPass ? "ALL PASS" : "SOME FAILED"}`);

  const evidence: ColdRestartEvidence = {
    scenario_id: "AS-2-cold",
    scenario_name: "Settlement committed, ack lost, coordinator retries → cold restart → no duplicate payout",
    hivepoa_sha: FREEZE.three_layer_sha_model?.frozen_bilateral_pair?.hivepoa || FREEZE.sha_pair?.hivepoa || "unknown",
    hiveai_sha: FREEZE.three_layer_sha_model?.frozen_bilateral_pair?.hiveai || FREEZE.sha_pair?.hiveai || "unknown",
    server_kills: serverKills,
    cold_restarts: coldRestarts,
    db_reconstruction: {
      jobs: [job],
      attempts,
      payouts,
      verifications,
    },
    assertions,
    timeline,
    pass: allPass,
  };

  emitEvidence(evidence);
  return evidence;
}

// ================================================================
// Main
// ================================================================
async function main() {
  console.log("Phase 1: Cold-Restart E2E — AS-1 and AS-2");
  console.log("==========================================");
  console.log(`Test prefix: ${TEST_PREFIX}`);
  console.log(`Database: ${DB_URL}`);
  console.log(`Server port: ${PORT}`);
  console.log();

  try {
    // Seed auth rows directly in DB
    await seedAuth();

    // Run AS-1
    const as1 = await runAS1();

    if (!as1.pass) {
      console.error("\nAS-1 FAILED — aborting AS-2");
      process.exit(1);
    }

    // Extract jobId and attemptId for AS-2 (continue from same job)
    const jobId = as1.db_reconstruction.jobs[0]?.id as string;
    const attemptId = as1.db_reconstruction.attempts[0]?.id as string;

    // Run AS-2
    const as2 = await runAS2(jobId, attemptId);

    // Summary
    console.log("\n==========================================");
    console.log("SUMMARY");
    console.log("==========================================");
    console.log(`AS-1: ${as1.pass ? "PASS" : "FAIL"} (${as1.server_kills} kills, ${as1.cold_restarts} restarts)`);
    console.log(`AS-2: ${as2.pass ? "PASS" : "FAIL"} (${as2.server_kills} kills, ${as2.cold_restarts} restarts)`);
    console.log(`Total server kills: ${as1.server_kills + as2.server_kills}`);
    console.log(`Total cold restarts: ${as1.cold_restarts + as2.cold_restarts}`);

    const allPass = as1.pass && as2.pass;

    // Write summary
    const summary = {
      step: "Phase 1: Cold-Restart E2E",
      run_at: new Date().toISOString(),
      scenarios: [
        { id: as1.scenario_id, pass: as1.pass },
        { id: as2.scenario_id, pass: as2.pass },
      ],
      total_server_kills: as1.server_kills + as2.server_kills,
      total_cold_restarts: as1.cold_restarts + as2.cold_restarts,
      reconstruction_boundary: "DB tables only — no in-process state, no event log, no request context",
      all_pass: allPass,
    };
    const dir = join(__dirname, "../evidence/cold-restart");
    writeFileSync(join(dir, "COLD_RESTART_SUMMARY.json"), JSON.stringify(summary, null, 2) + "\n");

    console.log(`\nOverall: ${allPass ? "ALL PASS" : "SOME FAILED"}`);
    process.exit(allPass ? 0 : 1);
  } catch (err) {
    console.error("\nFATAL ERROR:", err);
    process.exit(2);
  } finally {
    await pool.end();
  }
}

main();
