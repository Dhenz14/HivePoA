# GPU Compute Canary Test Plan — V1

Frozen: 2026-03-15
HivePoA commit: f9d328a
Hive-AI commit: 9fd95af
Payout mode: dry-run (pending → queued, no treasury broadcast)

## Test Conditions

| Condition | Required Value |
|-----------|---------------|
| HivePoA server | Running, API reachable |
| PostgreSQL | Running, compute tables exist |
| Model server | llama-server or Ollama with a loaded model |
| Worker auth | Valid agent API key |
| Coordinator auth | Valid Bearer session token |
| Payout mode | Dry-run (settle moves to queued, no HBD transfer) |

## Test 1: Live eval_sweep End-to-End

**Action:**
1. Coordinator creates eval_sweep job (budget=1.000, limit=10)
2. Worker claims, starts, runs regression_eval.py, submits result
3. HivePoA verifies structurally → accepted

**Pass criteria:**
- Job state reaches `accepted`
- Attempt state is `accepted`
- resultJson contains `overall_score`, `scores`, `challenges_run`
- outputSha256 is 64 hex chars
- 3 payouts created: validity_fee + completion_fee + bonus
- All payouts status=`pending`

**Fail if:** Job stuck in queued/leased/running >10min, or state=rejected

---

## Test 2: Live benchmark_run End-to-End

**Action:**
1. Coordinator creates benchmark_run job (budget=1.000)
2. Worker claims, runs executable_eval.py, submits

**Pass criteria:**
- Same as Test 1 but workloadType=benchmark_run
- resultJson contains `overall_score`, `challenges_run`, `scores`

---

## Test 3: Structural Corruption Rejected

**Action:**
1. Create eval_sweep job
2. Worker claims and starts
3. Worker submits with deliberately bad payload:
   - outputSha256 = "0000...0000" (64 zeros, wrong hash)
   - resultJson = `"not json"` (invalid)
   - OR outputCid = "" (empty)

**Pass criteria:**
- HivePoA structural verifier returns result=`fail`
- Attempt state = `rejected`
- Job re-queued (if attempts remain) or state=`rejected`
- No payouts created for this attempt
- Node reputation decreased

---

## Test 4: Semantic Corruption Rejected

**Action:**
1. Create eval_sweep job
2. Worker claims, starts, runs real eval
3. Worker modifies resultJson before submitting:
   - Set `overall_score: 0.99` (inflated)
   - Set all domain scores to 0.99
4. HivePoA accepts structurally (payload is valid JSON with correct fields)
5. Coordinator runs Hive-AI verifier on the accepted result

**Pass criteria:**
- HivePoA inline verifier: `pass` (structural is fine)
- Hive-AI verifier: `fail` or `soft_fail` (score deviation > 15%)
- verifier.score_deviation > 0.15
- Coordinator logs rejection

**Note:** This tests the Hive-AI verifier, not HivePoA. HivePoA correctly passes structural checks. The coordinator must gate settlement on Hive-AI verification.

---

## Test 5: Two Concurrent eval_sweep Jobs

**Action:**
1. Coordinator creates 2 eval_sweep jobs simultaneously
2. Single worker claims both (if maxConcurrentJobs >= 2) or two workers each claim one
3. Both complete

**Pass criteria:**
- Both jobs reach `accepted`
- Each job has its own attempt with distinct leaseToken
- Result artifacts are distinct (different outputSha256)
- No cross-contamination: each resultJson reflects its own eval run
- 6 total payouts (3 per job)
- Verifier temp files cleaned up (no leftover verifier_ledger_*.json)

---

## Test 6: Mixed Concurrent Jobs (eval_sweep + benchmark_run)

**Action:**
1. Create 1 eval_sweep + 1 benchmark_run simultaneously
2. Worker(s) claim and complete both

**Pass criteria:**
- Both accepted
- workloadType matches in each result
- No type confusion (eval result in benchmark job or vice versa)

---

## Test 7: Lease-Expiry Recovery

**Action:**
1. Create eval_sweep job
2. Worker claims job (gets leaseToken)
3. Worker does NOT send any heartbeats or progress
4. Wait >2 minutes (heartbeat timeout)
5. Verify lease sweeper marks attempt as timed_out
6. Second worker claims and completes the same job

**Pass criteria:**
- First attempt state = `timed_out`
- First attempt failureReason = "Heartbeat timeout"
- Job state returned to `queued` after first attempt timeout
- Job attemptCount = 2
- Second attempt state = `accepted`
- Second worker gets full payouts
- First worker gets zero payouts

---

## Test 8: Duplicate Submit + Duplicate Settle Replay

**Action (submit replay):**
1. Worker completes job normally → accepted
2. Worker replays the same submit call (same attemptId + leaseToken)

**Pass criteria (submit):**
- Second submit returns error (attempt not in `running` state)
- No duplicate verifications created
- No duplicate payouts

**Action (settle replay):**
1. Coordinator calls POST /jobs/:id/settle → payouts move to queued
2. Coordinator calls POST /jobs/:id/settle again

**Pass criteria (settle):**
- Second settle returns settled=0 (no pending payouts left)
- Payout records unchanged (still queued, not double-queued)
- Total payout count unchanged

---

## Environment Probe Checklist

Before running, record:

- [ ] PostgreSQL: running? version? compute tables exist?
- [ ] HivePoA server: running? port? commit hash?
- [ ] Model server: running? type (ollama/llama-server)? model? port?
- [ ] Agent API key: created?
- [ ] Bearer session token: valid?
- [ ] Worker script: can import without errors?
- [ ] Verifier script: can import without errors?

## Execution Order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

Do NOT skip ahead. Each test validates assumptions the next test depends on.

## After All 8 Pass

- Record exact commit hashes, model version, timing
- Archive test logs
- Status: **V1 canary validated**
- Next: treasury-backed smoke test (real HBD, if desired)
- Then and only then: discuss V2 federated training
