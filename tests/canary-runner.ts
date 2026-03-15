/**
 * tests/canary-runner.ts
 *
 * Automated canary test runner for GPU compute marketplace.
 * Executes all 8 tests from canary-test-plan.md against a live HivePoA instance.
 *
 * Prerequisites:
 *   - PostgreSQL running with compute tables
 *   - HivePoA server running
 *   - Valid agent API key and session token
 *
 * Usage:
 *   npx tsx tests/canary-runner.ts
 *
 * Environment variables:
 *   HIVEPOA_URL        — HivePoA server URL (default: http://localhost:3000)
 *   CANARY_AUTH_TOKEN   — Bearer session token for coordinator
 *   CANARY_API_KEY      — Agent API key for worker
 *   MODEL_NAME          — Ollama model name (default: qwen3:14b)
 */

import { randomBytes, createHash } from "crypto";

const BASE_URL = process.env.HIVEPOA_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.CANARY_AUTH_TOKEN || "";
const API_KEY = process.env.CANARY_API_KEY || "";
const NODE_INSTANCE_ID = `canary-test-${randomBytes(6).toString("hex")}`;

const results: { test: string; pass: boolean; details: string }[] = [];

// ================================================================
// HTTP helpers
// ================================================================

async function api(
  method: string, path: string, body?: any,
  auth: "bearer" | "apikey" = "bearer"
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth === "bearer" && AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  } else if (auth === "apikey" && API_KEY) {
    headers["Authorization"] = `ApiKey ${API_KEY}`;
  }

  const resp = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try { data = await resp.json(); } catch { data = null; }
  return { status: resp.status, data };
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function record(test: string, pass: boolean, details: string): void {
  results.push({ test, pass, details });
  const icon = pass ? "PASS" : "FAIL";
  console.log(`\n[${icon}] ${test}`);
  if (details) console.log(`  ${details}`);
}

// ================================================================
// Test helpers
// ================================================================

async function registerNode(): Promise<void> {
  const { status, data } = await api("POST", "/api/compute/nodes/register", {
    nodeInstanceId: NODE_INSTANCE_ID,
    gpuModel: "Canary-Test-GPU",
    gpuVramGb: 24,
    supportedWorkloads: "eval_sweep,benchmark_run",
    cachedModels: "qwen3:14b",
    workerVersion: "canary-1.0.0",
    maxConcurrentJobs: 2,
  }, "bearer");
  assert(status === 200, `Node registration failed: ${status} ${JSON.stringify(data)}`);
}

async function createJob(workloadType: string, budget = "1.000"): Promise<string> {
  const manifest = {
    schema_version: 1,
    workload_type: workloadType,
    executor_type: "canary-test",
    executor_version: "1.0.0",
    model_name: process.env.MODEL_NAME || "qwen3:14b",
  };
  const { status, data } = await api("POST", "/api/compute/jobs", {
    workloadType,
    manifest,
    budgetHbd: budget,
    minVramGb: 16,
    leaseSeconds: 300,
    maxAttempts: 3,
  }, "bearer");
  assert(status === 201, `Job creation failed: ${status} ${JSON.stringify(data)}`);
  return data.id;
}

async function claimJob(): Promise<{ jobId: string; attemptId: string; leaseToken: string } | null> {
  const { data } = await api("POST", "/api/compute/jobs/claim-next", {
    nodeInstanceId: NODE_INSTANCE_ID,
  }, "apikey");
  if (!data?.job) return null;
  return {
    jobId: data.job.id,
    attemptId: data.attempt.id,
    leaseToken: data.attempt.leaseToken,
  };
}

async function startJob(jobId: string, attemptId: string, leaseToken: string): Promise<void> {
  await api("POST", `/api/compute/jobs/${jobId}/start`, { attemptId, leaseToken }, "apikey");
}

async function submitGoodResult(jobId: string, attemptId: string, leaseToken: string): Promise<any> {
  const fakeResult = {
    overall_score: 0.85,
    challenges_run: 10,
    challenges_passed: 8,
    scores: { python: 0.9, rust: 0.8, go: 0.85 },
    category_scores: { python: 0.9, rust: 0.8, go: 0.85 },
    total_time_sec: 120.5,
    model_name: "canary-test",
    score: 0.85,
  };
  const resultStr = JSON.stringify(fakeResult);
  const sha256 = createHash("sha256").update(resultStr).digest("hex");

  const { status, data } = await api("POST", `/api/compute/jobs/${jobId}/submit`, {
    attemptId,
    leaseToken,
    outputCid: `sha256:${sha256}`,
    outputSha256: sha256,
    outputSizeBytes: resultStr.length,
    resultJson: resultStr,
    metricsJson: JSON.stringify({ wall_time_sec: 120.5, worker_version: "canary" }),
  }, "apikey");
  return { status, data };
}

async function getJob(jobId: string): Promise<any> {
  const { data } = await api("GET", `/api/compute/jobs/${jobId}`, undefined, "bearer");
  return data;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ================================================================
// Tests
// ================================================================

async function test1_evalSweepE2E(): Promise<void> {
  const name = "Test 1: eval_sweep end-to-end";
  try {
    const jobId = await createJob("eval_sweep");
    const claimed = await claimJob();
    assert(claimed !== null, "No job claimed");
    assert(claimed!.jobId === jobId, "Wrong job claimed");

    await startJob(claimed!.jobId, claimed!.attemptId, claimed!.leaseToken);
    const { status } = await submitGoodResult(claimed!.jobId, claimed!.attemptId, claimed!.leaseToken);

    const job = await getJob(jobId);
    assert(job.state === "accepted", `Expected accepted, got ${job.state}`);
    assert(job.payouts.length === 3, `Expected 3 payouts, got ${job.payouts.length}`);
    assert(job.payouts.every((p: any) => p.status === "pending"), "Payouts should be pending");
    assert(job.verifications.length >= 1, "Should have verifications");

    record(name, true, `Job ${jobId} accepted, 3 payouts staged`);
  } catch (e: any) {
    record(name, false, e.message);
  }
}

async function test2_benchmarkRunE2E(): Promise<void> {
  const name = "Test 2: benchmark_run end-to-end";
  try {
    const jobId = await createJob("benchmark_run");
    const claimed = await claimJob();
    assert(claimed !== null, "No job claimed");

    await startJob(claimed!.jobId, claimed!.attemptId, claimed!.leaseToken);
    await submitGoodResult(claimed!.jobId, claimed!.attemptId, claimed!.leaseToken);

    const job = await getJob(jobId);
    assert(job.state === "accepted", `Expected accepted, got ${job.state}`);
    assert(job.payouts.length === 3, `Expected 3 payouts, got ${job.payouts.length}`);

    record(name, true, `Job ${jobId} accepted`);
  } catch (e: any) {
    record(name, false, e.message);
  }
}

async function test3_structuralCorruptionRejected(): Promise<void> {
  const name = "Test 3: structural corruption rejected";
  try {
    const jobId = await createJob("eval_sweep");
    const claimed = await claimJob();
    assert(claimed !== null, "No job claimed");

    await startJob(claimed!.jobId, claimed!.attemptId, claimed!.leaseToken);

    // Submit with missing outputCid and bad resultJson
    const { status, data } = await api("POST", `/api/compute/jobs/${jobId}/submit`, {
      attemptId: claimed!.attemptId,
      leaseToken: claimed!.leaseToken,
      outputCid: "",
      outputSha256: "0".repeat(64),
      resultJson: "not valid json {{{",
    }, "apikey");

    // Should either fail validation at route level or be rejected by verifier
    const job = await getJob(jobId);
    // Job should be re-queued or rejected (structural fail)
    const attempt = job.attempts?.find((a: any) => a.id === claimed!.attemptId);
    const isRejected = attempt?.state === "rejected" || job.state === "queued" || status === 400;
    assert(isRejected, `Expected rejection, got job.state=${job.state}, attempt.state=${attempt?.state}, status=${status}`);

    record(name, true, `Structural corruption correctly rejected`);
  } catch (e: any) {
    record(name, false, e.message);
  }
}

async function test4_semanticCorruptionDetectable(): Promise<void> {
  const name = "Test 4: semantic corruption detectable";
  try {
    // This test verifies that a well-formed but falsified result
    // passes HivePoA structural checks but would fail Hive-AI verification.
    // Since Hive-AI verifier runs separately, we verify the structure is accepted
    // and the inflated scores are preserved for the verifier to catch.
    const jobId = await createJob("eval_sweep");
    const claimed = await claimJob();
    assert(claimed !== null, "No job claimed");

    await startJob(claimed!.jobId, claimed!.attemptId, claimed!.leaseToken);

    const inflatedResult = {
      overall_score: 0.99,
      challenges_run: 60,
      challenges_passed: 59,
      scores: { python: 0.99, rust: 0.99, go: 0.99, cpp: 0.99, js: 0.99, hive: 0.99 },
      category_scores: { python: 0.99, rust: 0.99, go: 0.99 },
      total_time_sec: 10,
      model_name: "canary-inflated",
      score: 0.99,
    };
    const resultStr = JSON.stringify(inflatedResult);
    const sha256 = createHash("sha256").update(resultStr).digest("hex");

    await api("POST", `/api/compute/jobs/${jobId}/submit`, {
      attemptId: claimed!.attemptId,
      leaseToken: claimed!.leaseToken,
      outputCid: `sha256:${sha256}`,
      outputSha256: sha256,
      outputSizeBytes: resultStr.length,
      resultJson: resultStr,
      metricsJson: JSON.stringify({ wall_time_sec: 10 }),
    }, "apikey");

    const job = await getJob(jobId);
    // HivePoA should structurally accept (valid JSON, correct fields)
    // The inflated scores are preserved in resultJson for Hive-AI verifier to catch
    assert(job.state === "accepted", `Expected structural acceptance, got ${job.state}`);
    const attempt = job.attempts?.find((a: any) => a.id === claimed!.attemptId);
    assert(attempt?.resultJson?.includes("0.99"), "Inflated scores should be preserved for verifier");

    record(name, true, `Structurally accepted — Hive-AI verifier would catch 0.99 scores via deviation check`);
  } catch (e: any) {
    record(name, false, e.message);
  }
}

async function test5_concurrentSameType(): Promise<void> {
  const name = "Test 5: two concurrent eval_sweep jobs";
  try {
    const jobId1 = await createJob("eval_sweep", "0.500");
    const jobId2 = await createJob("eval_sweep", "0.500");

    const claimed1 = await claimJob();
    assert(claimed1 !== null, "First claim failed");

    const claimed2 = await claimJob();
    assert(claimed2 !== null, "Second claim failed");

    assert(claimed1!.jobId !== claimed2!.jobId, "Both claims got same job — atomic claim failed");

    await startJob(claimed1!.jobId, claimed1!.attemptId, claimed1!.leaseToken);
    await startJob(claimed2!.jobId, claimed2!.attemptId, claimed2!.leaseToken);

    await submitGoodResult(claimed1!.jobId, claimed1!.attemptId, claimed1!.leaseToken);
    await submitGoodResult(claimed2!.jobId, claimed2!.attemptId, claimed2!.leaseToken);

    const job1 = await getJob(jobId1);
    const job2 = await getJob(jobId2);

    assert(job1.state === "accepted", `Job 1: expected accepted, got ${job1.state}`);
    assert(job2.state === "accepted", `Job 2: expected accepted, got ${job2.state}`);
    assert(job1.payouts.length === 3, "Job 1 should have 3 payouts");
    assert(job2.payouts.length === 3, "Job 2 should have 3 payouts");

    record(name, true, `Both jobs accepted independently, 6 total payouts`);
  } catch (e: any) {
    record(name, false, e.message);
  }
}

async function test6_concurrentMixedType(): Promise<void> {
  const name = "Test 6: concurrent eval_sweep + benchmark_run";
  try {
    const evalJobId = await createJob("eval_sweep", "0.500");
    const benchJobId = await createJob("benchmark_run", "0.500");

    const claimed1 = await claimJob();
    const claimed2 = await claimJob();
    assert(claimed1 !== null && claimed2 !== null, "Failed to claim both jobs");

    await startJob(claimed1!.jobId, claimed1!.attemptId, claimed1!.leaseToken);
    await startJob(claimed2!.jobId, claimed2!.attemptId, claimed2!.leaseToken);

    await submitGoodResult(claimed1!.jobId, claimed1!.attemptId, claimed1!.leaseToken);
    await submitGoodResult(claimed2!.jobId, claimed2!.attemptId, claimed2!.leaseToken);

    const evalJob = await getJob(evalJobId);
    const benchJob = await getJob(benchJobId);

    assert(evalJob.state === "accepted", `Eval job: ${evalJob.state}`);
    assert(benchJob.state === "accepted", `Bench job: ${benchJob.state}`);
    assert(evalJob.workloadType === "eval_sweep", "Type confusion on eval job");
    assert(benchJob.workloadType === "benchmark_run", "Type confusion on bench job");

    record(name, true, `Both types accepted, no confusion`);
  } catch (e: any) {
    record(name, false, e.message);
  }
}

async function test7_leaseExpiryRecovery(): Promise<void> {
  const name = "Test 7: lease-expiry recovery";
  try {
    const jobId = await createJob("eval_sweep");
    const claimed1 = await claimJob();
    assert(claimed1 !== null, "First claim failed");

    // Do NOT heartbeat — let lease expire
    console.log("  Waiting 130s for lease to expire...");
    await sleep(130_000);

    // Check that the first attempt timed out
    let job = await getJob(jobId);
    const firstAttempt = job.attempts?.find((a: any) => a.id === claimed1!.attemptId);
    assert(
      firstAttempt?.state === "timed_out" || job.state === "queued",
      `Expected timed_out or re-queued, got attempt=${firstAttempt?.state} job=${job.state}`
    );

    // Second worker claims the re-queued job
    const claimed2 = await claimJob();
    assert(claimed2 !== null, "Second claim after expiry failed");
    assert(claimed2!.jobId === jobId, "Second claim got wrong job");

    await startJob(claimed2!.jobId, claimed2!.attemptId, claimed2!.leaseToken);
    await submitGoodResult(claimed2!.jobId, claimed2!.attemptId, claimed2!.leaseToken);

    job = await getJob(jobId);
    assert(job.state === "accepted", `Expected accepted, got ${job.state}`);
    assert(job.attempts.length === 2, `Expected 2 attempts, got ${job.attempts.length}`);

    // Verify first attempt has no payouts, second does
    const firstPayouts = job.payouts.filter((p: any) => p.attemptId === claimed1!.attemptId);
    const secondPayouts = job.payouts.filter((p: any) => p.attemptId === claimed2!.attemptId);
    assert(firstPayouts.length === 0, `First attempt should have 0 payouts, got ${firstPayouts.length}`);
    assert(secondPayouts.length === 3, `Second attempt should have 3 payouts, got ${secondPayouts.length}`);

    record(name, true, `Lease expired, job recovered by second worker`);
  } catch (e: any) {
    record(name, false, e.message);
  }
}

async function test8_duplicateReplay(): Promise<void> {
  const name = "Test 8: duplicate submit + duplicate settle";
  try {
    const jobId = await createJob("eval_sweep");
    const claimed = await claimJob();
    assert(claimed !== null, "Claim failed");

    await startJob(claimed!.jobId, claimed!.attemptId, claimed!.leaseToken);
    await submitGoodResult(claimed!.jobId, claimed!.attemptId, claimed!.leaseToken);

    let job = await getJob(jobId);
    assert(job.state === "accepted", `Expected accepted, got ${job.state}`);
    const initialPayoutCount = job.payouts.length;

    // Replay submit — should fail (attempt not in running state)
    const { status: resubmitStatus } = await submitGoodResult(
      claimed!.jobId, claimed!.attemptId, claimed!.leaseToken
    );
    assert(resubmitStatus === 400, `Replay submit should fail, got ${resubmitStatus}`);

    // Verify no extra payouts
    job = await getJob(jobId);
    assert(job.payouts.length === initialPayoutCount, `Payout count changed after replay: ${job.payouts.length} vs ${initialPayoutCount}`);

    // Settle payouts
    const { data: settle1 } = await api("POST", `/api/compute/jobs/${jobId}/settle`, undefined, "bearer");
    const settledCount = settle1?.settled || 0;

    // Replay settle — should return 0
    const { data: settle2 } = await api("POST", `/api/compute/jobs/${jobId}/settle`, undefined, "bearer");
    assert(settle2?.settled === 0, `Settle replay should return 0, got ${settle2?.settled}`);

    // Verify payout count unchanged
    job = await getJob(jobId);
    assert(job.payouts.length === initialPayoutCount, "Payout count changed after settle replay");

    record(name, true, `Duplicate submit rejected, settle idempotent`);
  } catch (e: any) {
    record(name, false, e.message);
  }
}

// ================================================================
// Runner
// ================================================================

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════");
  console.log("  GPU Compute Canary Test Runner");
  console.log("═══════════════════════════════════════════════");
  console.log(`HivePoA:  ${BASE_URL}`);
  console.log(`Node ID:  ${NODE_INSTANCE_ID}`);
  console.log(`Auth:     token=${AUTH_TOKEN ? "set" : "MISSING"} apikey=${API_KEY ? "set" : "MISSING"}`);
  console.log("");

  if (!AUTH_TOKEN || !API_KEY) {
    console.error("ERROR: Set CANARY_AUTH_TOKEN and CANARY_API_KEY environment variables");
    process.exit(1);
  }

  // Pre-flight: check HivePoA is reachable
  try {
    const { status } = await api("GET", "/api/compute/stats", undefined, "bearer");
    if (status !== 200) throw new Error(`Stats endpoint returned ${status}`);
  } catch (e: any) {
    console.error(`ERROR: HivePoA not reachable at ${BASE_URL}: ${e.message}`);
    process.exit(1);
  }

  // Register test node
  await registerNode();
  console.log(`Node registered: ${NODE_INSTANCE_ID}\n`);

  // Run tests in order
  await test1_evalSweepE2E();
  await test2_benchmarkRunE2E();
  await test3_structuralCorruptionRejected();
  await test4_semanticCorruptionDetectable();
  await test5_concurrentSameType();
  await test6_concurrentMixedType();
  await test7_leaseExpiryRecovery();
  await test8_duplicateReplay();

  // Summary
  console.log("\n═══════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════");
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  for (const r of results) {
    console.log(`  ${r.pass ? "✓" : "✗"} ${r.test}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    console.log("\n  FAILED TESTS:");
    for (const r of results.filter(r => !r.pass)) {
      console.log(`    ${r.test}: ${r.details}`);
    }
    process.exit(1);
  } else {
    console.log("\n  ALL CANARY TESTS PASSED — V1 validated");
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
