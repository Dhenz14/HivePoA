#!/usr/bin/env node
/**
 * scripts/soak-runner.js
 *
 * Standalone resumable operational soak test for GPU compute marketplace.
 * Runs sequential eval_sweep/benchmark_run cycles with real HBD settlement.
 *
 * Survives: server restarts, model failures, network hiccups, terminal close.
 * Uses a local JSON journal for state persistence and reconciliation.
 *
 * Usage:
 *   node scripts/soak-runner.js                    # Live mode (real HBD)
 *   node scripts/soak-runner.js --dry-run          # Dry run (no treasury transfers)
 *   node scripts/soak-runner.js --cycles 5         # Run N cycles then stop
 *   node scripts/soak-runner.js --status           # Print journal status
 *
 * Environment:
 *   HIVEPOA_URL          http://localhost:3000
 *   CANARY_AUTH_TOKEN    Bearer session token
 *   CANARY_API_KEY       Agent API key
 *   TREASURY_ACTIVE_KEY  Active private key for treasury account
 *   TREASURY_ACCOUNT     nickhintonnarc
 *   WORKER_ACCOUNT       dandandan123
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ================================================================
// Configuration — hard caps
// ================================================================
const DAILY_BUDGET_CAP_HBD = 0.050;
const PER_JOB_BUDGET_HBD = "0.010";
const MAX_CONSECUTIVE_ERRORS = 3;
const MIN_CYCLE_DELAY_MS = 30_000;   // 30s minimum between cycles
const MAX_CYCLE_JITTER_MS = 60_000;  // up to 60s additional random delay
const HEARTBEAT_INTERVAL_MS = 20_000;
const LEASE_SECONDS = 1800;
const NODE_INSTANCE_ID = "soak-runner-node-001";

// ================================================================
// Environment — load from .soak-env file (keys never on command line)
// ================================================================
const ENV_FILE = path.join(__dirname, "..", ".soak-env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const BASE_URL = process.env.HIVEPOA_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.CANARY_AUTH_TOKEN || "";
const API_KEY = process.env.CANARY_API_KEY || "";
const TREASURY_KEY = process.env.TREASURY_ACTIVE_KEY || "";
const TREASURY_ACCOUNT = process.env.TREASURY_ACCOUNT || "nickhintonnarc";
const WORKER_ACCOUNT = process.env.WORKER_ACCOUNT || "dandandan123";

const DRY_RUN = process.argv.includes("--dry-run");
const STATUS_ONLY = process.argv.includes("--status");
const MAX_CYCLES_ARG = process.argv.indexOf("--cycles");
const MAX_CYCLES = MAX_CYCLES_ARG >= 0 ? parseInt(process.argv[MAX_CYCLES_ARG + 1]) : Infinity;

const JOURNAL_PATH = path.join(__dirname, "..", "soak-journal.json");

// ================================================================
// Journal — persistent state
// ================================================================
function loadJournal() {
  if (fs.existsSync(JOURNAL_PATH)) {
    return JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8"));
  }
  return {
    created: new Date().toISOString(),
    totalCycles: 0,
    totalSpentHbd: 0,
    dailySpentHbd: 0,
    dailyResetDate: new Date().toISOString().slice(0, 10),
    consecutiveErrors: 0,
    lastError: null,
    lastCycleAt: null,
    stoppedReason: null,
    cycles: [],
  };
}

function saveJournal(j) {
  fs.writeFileSync(JOURNAL_PATH, JSON.stringify(j, null, 2));
}

function resetDailyIfNeeded(j) {
  const today = new Date().toISOString().slice(0, 10);
  if (j.dailyResetDate !== today) {
    j.dailySpentHbd = 0;
    j.dailyResetDate = today;
  }
}

// ================================================================
// HTTP helpers
// ================================================================
async function api(method, path, body, auth) {
  const headers = { "Content-Type": "application/json" };
  if (auth === "apikey") headers["Authorization"] = `ApiKey ${API_KEY}`;
  else headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;

  const resp = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  let data;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) throw new Error(`API ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

async function getHiveBalance(account) {
  const resp = await fetch("https://api.hive.blog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "condenser_api.get_accounts",
      params: [[account]],
      id: 1,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json();
  return parseFloat(data.result[0].hbd_balance);
}

async function sendHbd(from, to, amount, memo) {
  const dhive = require("@hiveio/dhive");
  const client = new dhive.Client(["https://api.hive.blog", "https://api.deathwing.me"]);
  const key = dhive.PrivateKey.fromString(TREASURY_KEY);
  const op = ["transfer", { from, to, amount: amount + " HBD", memo }];
  const result = await client.broadcast.sendOperations([op], key);
  return result.id;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ================================================================
// Single soak cycle
// ================================================================
async function runCycle(journal, cycleNum) {
  const workloadType = cycleNum % 2 === 0 ? "eval_sweep" : "benchmark_run";
  const cycleId = `soak-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const budget = PER_JOB_BUDGET_HBD;

  const record = {
    cycleId,
    cycleNum,
    workloadType,
    budgetHbd: budget,
    startedAt: new Date().toISOString(),
    jobId: null,
    attemptId: null,
    jobState: null,
    payoutsCount: 0,
    payoutsTotalHbd: 0,
    settledCount: 0,
    treasuryTxId: null,
    treasuryBalanceBefore: null,
    treasuryBalanceAfter: null,
    workerBalanceBefore: null,
    workerBalanceAfter: null,
    error: null,
    finishedAt: null,
    reconciled: false,
  };

  const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] [cycle ${cycleNum}] ${msg}`);

  try {
    // Pre-balance snapshot
    record.treasuryBalanceBefore = await getHiveBalance(TREASURY_ACCOUNT);
    record.workerBalanceBefore = await getHiveBalance(WORKER_ACCOUNT);
    log(`Balances: treasury=${record.treasuryBalanceBefore} worker=${record.workerBalanceBefore}`);

    // Budget guard (skip in dry-run — treasury has no balance)
    if (!DRY_RUN && record.treasuryBalanceBefore < parseFloat(budget)) {
      throw new Error(`Treasury balance ${record.treasuryBalanceBefore} < job budget ${budget}`);
    }

    // 1. Create job
    const job = await api("POST", "/api/compute/jobs", {
      workloadType,
      manifest: {
        schema_version: 1,
        workload_type: workloadType,
        executor_type: "soak-test",
        executor_version: "1.0.0",
        model_name: "soak-test",
      },
      budgetHbd: budget,
      minVramGb: 8,
      leaseSeconds: LEASE_SECONDS,
      maxAttempts: 1,
    }, "bearer");
    record.jobId = job.id;
    log(`Created ${workloadType} job: ${job.id}`);

    // 2. Claim
    const claim = await api("POST", "/api/compute/jobs/claim-next", {
      nodeInstanceId: NODE_INSTANCE_ID,
    }, "apikey");
    if (!claim.job) throw new Error("Claim returned no job");
    record.attemptId = claim.attempt.id;
    const leaseToken = claim.attempt.leaseToken;
    log(`Claimed: attempt=${record.attemptId}`);

    // 3. Start
    await api("POST", `/api/compute/jobs/${record.jobId}/start`, {
      attemptId: record.attemptId,
      leaseToken,
    }, "apikey");
    log("Started");

    // 4. Heartbeat + simulate work
    await api("POST", `/api/compute/jobs/${record.jobId}/progress`, {
      attemptId: record.attemptId,
      leaseToken,
      progressPct: 50,
      currentStage: "processing",
    }, "apikey");

    // 5. Submit result
    const result = {
      overall_score: 0.85 + Math.random() * 0.1,
      challenges_run: 18,
      challenges_passed: 15 + Math.floor(Math.random() * 3),
      scores: { python: 0.9, rust: 0.82 },
      score: 0.87,
    };
    const resultStr = JSON.stringify(result);
    const sha = crypto.createHash("sha256").update(resultStr).digest("hex");

    await api("POST", `/api/compute/jobs/${record.jobId}/submit`, {
      attemptId: record.attemptId,
      leaseToken,
      outputCid: `sha256:${sha}`,
      outputSha256: sha,
      outputSizeBytes: resultStr.length,
      resultJson: resultStr,
      metricsJson: JSON.stringify({ wall_time_sec: 60, cycle: cycleNum }),
    }, "apikey");
    log("Submitted");

    // 6. Verify state + payouts
    const jobData = await api("GET", `/api/compute/jobs/${record.jobId}`, null, "bearer");
    record.jobState = jobData.state;
    record.payoutsCount = jobData.payouts.length;
    record.payoutsTotalHbd = jobData.payouts.reduce((s, p) => s + parseFloat(p.amountHbd), 0);
    log(`State: ${record.jobState}, payouts: ${record.payoutsCount} (${record.payoutsTotalHbd.toFixed(3)} HBD)`);

    if (record.jobState !== "accepted") {
      throw new Error(`Job not accepted: ${record.jobState}`);
    }

    // 7. Settle
    const settled = await api("POST", `/api/compute/jobs/${record.jobId}/settle`, null, "bearer");
    record.settledCount = settled.settled;
    log(`Settled: ${record.settledCount}`);

    // 7b. Duplicate settle guard
    const settled2 = await api("POST", `/api/compute/jobs/${record.jobId}/settle`, null, "bearer");
    if (settled2.settled !== 0) {
      throw new Error(`DUPLICATE SETTLE: second settle returned ${settled2.settled} (expected 0)`);
    }

    // 8. Treasury transfer (skip in dry-run or if amount is zero)
    if (!DRY_RUN && TREASURY_KEY) {
      const payoutAmount = record.payoutsTotalHbd.toFixed(3);
      if (parseFloat(payoutAmount) < 0.001) {
        log(`Payout too small to transfer (${payoutAmount} HBD) — skipping on-chain transfer`);
      } else {
        const memo = `HIVEPOA_SOAK_${cycleId}`;
        log(`Treasury transfer: ${payoutAmount} HBD → ${WORKER_ACCOUNT} (memo: ${memo})`);

        const txId = await sendHbd(TREASURY_ACCOUNT, WORKER_ACCOUNT, payoutAmount, memo);
        record.treasuryTxId = txId;
        log(`Transfer broadcast: ${txId}`);

        // Wait for confirmation
        await sleep(4000);
      }
    } else {
      log("DRY RUN — skipping treasury transfer");
    }

    // 9. Post-balance reconciliation
    record.treasuryBalanceAfter = await getHiveBalance(TREASURY_ACCOUNT);
    record.workerBalanceAfter = await getHiveBalance(WORKER_ACCOUNT);
    log(`Post-balances: treasury=${record.treasuryBalanceAfter} worker=${record.workerBalanceAfter}`);

    if (!DRY_RUN && TREASURY_KEY) {
      const expectedTreasuryDelta = -record.payoutsTotalHbd;
      const actualTreasuryDelta = record.treasuryBalanceAfter - record.treasuryBalanceBefore;
      const balanceMismatch = Math.abs(actualTreasuryDelta - expectedTreasuryDelta) > 0.0015;
      if (balanceMismatch) {
        throw new Error(
          `BALANCE MISMATCH: treasury expected delta ${expectedTreasuryDelta.toFixed(3)}, ` +
          `actual ${actualTreasuryDelta.toFixed(3)}`
        );
      }
    }

    record.reconciled = true;
    record.finishedAt = new Date().toISOString();
    log("CYCLE PASS — reconciled");

    // Update journal
    journal.totalCycles++;
    journal.totalSpentHbd += record.payoutsTotalHbd;
    journal.dailySpentHbd += record.payoutsTotalHbd;
    journal.consecutiveErrors = 0;
    journal.lastError = null;
    journal.lastCycleAt = record.finishedAt;

  } catch (err) {
    record.error = err.message;
    record.finishedAt = new Date().toISOString();
    log(`CYCLE FAIL: ${err.message}`);

    journal.consecutiveErrors++;
    journal.lastError = err.message;
  }

  journal.cycles.push(record);
  saveJournal(journal);
  return record;
}

// ================================================================
// Main loop
// ================================================================
async function main() {
  const journal = loadJournal();

  if (STATUS_ONLY) {
    console.log("=== SOAK JOURNAL STATUS ===");
    console.log(`Total cycles:    ${journal.totalCycles}`);
    console.log(`Total spent:     ${journal.totalSpentHbd.toFixed(3)} HBD`);
    console.log(`Daily spent:     ${journal.dailySpentHbd.toFixed(3)} HBD`);
    console.log(`Consec errors:   ${journal.consecutiveErrors}`);
    console.log(`Last error:      ${journal.lastError || "none"}`);
    console.log(`Last cycle:      ${journal.lastCycleAt || "never"}`);
    console.log(`Stopped reason:  ${journal.stoppedReason || "none"}`);
    console.log(`Logged cycles:   ${journal.cycles.length}`);
    const failed = journal.cycles.filter(c => c.error).length;
    console.log(`Failed cycles:   ${failed}`);
    process.exit(0);
  }

  console.log("=== SOAK RUNNER STARTED ===");
  console.log(`Mode:        ${DRY_RUN ? "DRY RUN" : "LIVE (real HBD)"}`);
  console.log(`Max cycles:  ${MAX_CYCLES === Infinity ? "unlimited" : MAX_CYCLES}`);
  console.log(`Daily cap:   ${DAILY_BUDGET_CAP_HBD} HBD`);
  console.log(`Per-job:     ${PER_JOB_BUDGET_HBD} HBD`);
  console.log(`HivePoA:     ${BASE_URL}`);
  console.log(`Treasury:    ${TREASURY_ACCOUNT}`);
  console.log(`Worker:      ${WORKER_ACCOUNT}`);
  console.log(`Journal:     ${JOURNAL_PATH}`);
  console.log("");

  // Pre-flight
  try {
    await api("GET", "/api/compute/stats", null, "bearer");
  } catch (e) {
    console.error(`FATAL: HivePoA not reachable at ${BASE_URL}: ${e.message}`);
    process.exit(1);
  }

  // Register node
  try {
    await api("POST", "/api/compute/nodes/register", {
      nodeInstanceId: NODE_INSTANCE_ID,
      gpuModel: "Soak-Runner",
      gpuVramGb: 24,
      supportedWorkloads: "eval_sweep,benchmark_run",
      maxConcurrentJobs: 1,
    }, "bearer");
  } catch (e) {
    console.error(`FATAL: Node registration failed: ${e.message}`);
    process.exit(1);
  }

  // Clear stopped state if resuming
  journal.stoppedReason = null;
  saveJournal(journal);

  let cycleNum = journal.totalCycles;

  while (cycleNum < MAX_CYCLES) {
    resetDailyIfNeeded(journal);

    // Stop conditions
    if (journal.dailySpentHbd >= DAILY_BUDGET_CAP_HBD) {
      journal.stoppedReason = `Daily budget cap reached: ${journal.dailySpentHbd.toFixed(3)} >= ${DAILY_BUDGET_CAP_HBD}`;
      saveJournal(journal);
      console.log(`\nSTOPPED: ${journal.stoppedReason}`);
      break;
    }

    if (journal.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      journal.stoppedReason = `${MAX_CONSECUTIVE_ERRORS} consecutive errors. Last: ${journal.lastError}`;
      saveJournal(journal);
      console.log(`\nSTOPPED: ${journal.stoppedReason}`);
      break;
    }

    // Run one cycle
    cycleNum++;
    const record = await runCycle(journal, cycleNum);

    if (record.error) {
      // Don't sleep long on errors — the stop condition will catch repeated failures
      await sleep(5000);
      continue;
    }

    // Re-register to reset node state between cycles
    try {
      await api("POST", "/api/compute/nodes/register", {
        nodeInstanceId: NODE_INSTANCE_ID,
        gpuModel: "Soak-Runner",
        gpuVramGb: 24,
        supportedWorkloads: "eval_sweep,benchmark_run",
        maxConcurrentJobs: 1,
      }, "bearer");
    } catch { /* ignore */ }

    // Jittered delay
    const delay = MIN_CYCLE_DELAY_MS + Math.floor(Math.random() * MAX_CYCLE_JITTER_MS);
    console.log(`  Next cycle in ${(delay / 1000).toFixed(0)}s\n`);
    await sleep(delay);
  }

  console.log("\n=== SOAK RUNNER FINISHED ===");
  console.log(`Total cycles: ${journal.totalCycles}`);
  console.log(`Total spent:  ${journal.totalSpentHbd.toFixed(3)} HBD`);
  console.log(`Errors:       ${journal.cycles.filter(c => c.error).length}`);
  console.log(`Stopped:      ${journal.stoppedReason || "completed all cycles"}`);
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
