# GPU Compute Marketplace — Implementation Plan

## Status: All gems mapped, ordered by dependency, ready for GPT review

**Date:** 2026-03-16
**Baseline:** HivePoA `10eb565` (203 tests) · Hive-AI `a5e16e4` (69 conformance tests)
**Control document:** `next-session.md` (frozen, 8 decisions + 3 hard gates)

---

## What Already Works (DO NOT REBUILD)

These are proven and operationally validated. Building on top, not replacing.

| Component | Location | Status |
|-----------|----------|--------|
| Atomic job claiming (SELECT FOR UPDATE SKIP LOCKED) | HivePoA `compute-service.ts` | 8/8 canary PASS |
| Two-stage verification (structural + workload-specific) | HivePoA `compute-service.ts` | Catches inflated scores |
| Three-stage payouts (validity 30% + completion 40% + bonus 30%) | HivePoA `compute-service.ts` | 10 real-money cycles |
| Lease sweeper (2-min heartbeat timeout) | HivePoA `compute-service.ts` | Tested |
| Worker poll-claim-execute-submit loop | Hive-AI `worker.py` | 3/3 integrated canary |
| Heartbeat thread (20s interval) | Hive-AI `worker.py` | Keeps leases alive |
| EvalSweepVerifier + BenchmarkRunVerifier | Hive-AI `verifier.py` | 15% tolerance, 70% match rate |
| REST client (all 16 endpoints) | Hive-AI `compute_client.py` | Full coverage |
| Schema conformance (TypeScript + Python) | Both repos | 203 + 69 tests, frozen |
| 5 compute DB tables | HivePoA `schema.ts` | Nodes, jobs, attempts, verifications, payouts |
| Node reputation + warm-up restrictions | HivePoA `compute-service.ts` | rep<20 restricted |
| Cache-aware scheduling | HivePoA storage | Prefers nodes with cached models |

---

## What's Missing (The Gems)

### Gem Map: 28 implementation items across 8 phases

```
Phase 0: Transaction Integrity (PREREQUISITE — all subsequent phases depend on this)
  ├─ 0.0  Fix 7 broken Hive-AI tests (warmup + interface re-read)
  ├─ 0.5  Answer 8 design decisions + 3 hard gates
  ├─ 0.1  Provenance collection (worker-side)
  ├─ 0.2  IPFS artifact upload/download
  ├─ 0.3  Server-side nonce + dedup
  ├─ 0.4  Retry-safe state transitions + durable checkpoints
  ├─ 0.5b Structured observability
  ├─ 0.6  Fault injection tests
  └─ 0.7  Pydantic models from proven schemas

Phase 1: Data Generation Jobs
  ├─ 1.1  gen_pairs_worker.py executor
  ├─ 1.2  DataGenerationVerifier (layered checks)
  ├─ 1.3  Worker _execute_data_generation()
  └─ 1.4  Canary: 50-pair batch end-to-end

Phase 1.5: Adapter Validation
  ├─ 1.5.1  Worker _execute_adapter_validation()
  ├─ 1.5.2  AdapterValidationVerifier
  └─ 1.5.3  Reputation gate: unlocks micro-training

Phase 1.75: Micro-Training Canary
  ├─ 1.75.1  100-step training job creation
  ├─ 1.75.2  Worker trains + submits adapter
  └─ 1.75.3  Verifier loads + evals → "training-capable" reputation

Phase 2: Domain LoRA Training Jobs
  ├─ 2.1  train_domain_worker.py executor
  ├─ 2.2  DomainLoraTrainVerifier (full hidden eval)
  ├─ 2.3  Worker _execute_domain_lora_train()
  ├─ 2.4  Docker containerization for training workloads
  └─ 2.5  Canary: real adapter training end-to-end

Phase 3: Adapter Aggregation
  ├─ 3.1  aggregator.py (dense-delta + SVD)
  ├─ 3.2  Baseline registry + round manifest (off-chain + Hive hash anchors)
  └─ 3.3  Post-merge weakness-hunter flywheel (auto-generates data_generation jobs)

Phase 4: Federated Loop (deferred)
  ├─ 4.1  Block-hash-seeded shard assignment (deterministic, verifiable fairness)
  └─ 4.2  DiLoCo evaluation (research: benchmark vs FedEx-LoRA)

Phase UX: Worker Experience
  ├─ UX.1  Zero-config GPU auto-detection
  ├─ UX.2  Background daemon mode
  └─ UX.3  Electron desktop agent integration
```

---

## Phase 0 — Transaction Integrity

**Duration estimate:** Intentionally omitted per project rules.
**Prerequisite for:** Everything. No Phase 1+ work until Phase 0 completion criteria are met.

### Step 0.0 — Fix 7 Broken Hive-AI Tests

**What:** 7 tests in `tests/test_compute.py` are failing due to API drift.
**Why first:** Forces re-reading current `worker.py`, `verifier.py`, `compute_client.py` interfaces before adding new surface. Detect accidental vs intentional drift.

**Known failures:**
- `EvalSweepVerifier.verify()` signature changed (now requires `manifest` arg)
- `result_to_json()` signature changed

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `tests/test_compute.py` | Update test calls to match current signatures |
| Hive-AI | `hiveai/compute/models.py` | Verify `result_to_json()` current signature |
| Hive-AI | `hiveai/compute/verifier.py` | Verify `verify()` current signature |

**Acceptance:** All 7 tests pass. No behavior changes — tests align to reality.

---

### Step 0.5 — Design Decisions (HARD GATE)

**What:** Answer 8 decisions + 3 gates before writing any runtime code. Write answers into `docs/PHASE0_DECISIONS.md` in HivePoA AND reflect each decision in a test or constraint.

**Decisions to lock:**

| # | Decision | Candidates | Constraint it produces |
|---|----------|-----------|----------------------|
| D1 | Unit-of-work identity model | job_id / claim_id / attempt_id / settlement_id | DB schema, API fields |
| D2 | Server state machine transitions | who triggers, preconditions, terminal? | State guard code |
| D3 | Lease expiry ownership rule | reject late / conditional accept / record-only | Submit endpoint logic |
| D4 | Provenance mandatory vs advisory | per-field classification | Schema validation strictness |
| D5 | IPFS verification scope | local / coordinator-path / hash-only | upload_artifact() success condition |
| D6 | Time authority | server clock for all deadlines | Timestamp handling everywhere |
| D7 | Acceptance vs settlement thresholds | distinct or collapsed | Payout state machine |
| D8 | Mixed-version deployment | hard cutover or transition window | Error codes on v1 payloads |
| GA | Idempotency key | `(job_id, attempt_id, lease_token)` recommended | DB unique constraint |
| GB | Artifact trust authority | coordinator-retrievable CID recommended | Verification gate |
| GC | Late-work policy | reject after lease expiry recommended | Submit endpoint guard |

**Acceptance:** Each decision documented, each produces at least one test or DB constraint. Step 1 cannot begin until all 11 are locked.

---

### Step 0.1 — Provenance Collection (Worker-Side)

**What:** Worker collects structured provenance on every job and includes it in result submission.

**Provenance structure (3 categories, not flat):**

```python
@dataclass
class ProvenanceMetadata:
    # Identity (mandatory — protocol correctness)
    job_id: str
    job_nonce: str
    worker_version: str
    worker_git_sha: str
    schema_version: int  # 2

    # Environment (mandatory — reproducibility)
    platform: str           # "linux-x86_64"
    cuda_version: str | None
    torch_version: str | None
    quantization: str       # "4bit-bnb" | "none" | etc.

    # Derivation (mandatory for training, advisory for eval)
    base_model_sha256: str | None
    tokenizer_sha256: str | None
    dataset_cid: str | None
    dataset_sha256: str | None
    seed: int | None
    hyperparameters: dict | None

    # Runtime (mandatory)
    runtime: dict  # {cuda_version, torch_version, quantization, platform}
```

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/models.py` | Add `ProvenanceMetadata` dataclass, bump `SCHEMA_VERSION` to 2 (after D8 resolved) |
| Hive-AI | `hiveai/compute/worker.py` | Collect provenance in `_execute_eval_sweep()` and `_execute_benchmark_run()` |
| Hive-AI | `hiveai/compute/worker.py` | Validate provenance against `provenance_v2.json` schema before submission |
| Hive-AI | `tests/test_compute.py` | Tests for provenance collection + schema validation |

**Key implementation detail:** Validate provenance against the vendored `hiveai/schemas/provenance_v2.json` using `Draft202012Validator` + `FormatChecker()` BEFORE submitting to server. Reject locally if invalid — don't waste a round trip.

**Acceptance:**
- Every `submit_result()` call includes provenance JSON
- Provenance validates against `provenance_v2.json` schema
- Missing mandatory fields cause local rejection (not server round-trip)

---

### Step 0.2 — IPFS Artifact Upload/Download

**What:** Worker pins output artifacts to IPFS and reports real CIDs instead of `sha256:` placeholders.

**Current state:** `output_cid = f"sha256:{sha256_hex}"` — placeholder, no IPFS.
**Target state:** Real IPFS CID from Kubo daemon, verified retrieval before submission.

**5-step verification cycle:**
1. Compute content hash locally (SHA-256)
2. `ipfs add --pin` artifact file
3. Resolve returned CID
4. `ipfs cat <CID> | sha256sum` — verify read-back matches local hash
5. Only then submit CID to HivePoA

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/dbc/compute_client.py` | Add `upload_artifact(path) → (cid, sha256, size)` and `download_artifact(cid, dest_path) → path` |
| Hive-AI | `hiveai/compute/worker.py` | Replace `sha256:` placeholder with real IPFS pin + verification |
| Hive-AI | `tests/test_compute.py` | Mock IPFS tests (pin, read-back, failure modes) |

**Failure handling:**
- Pin succeeds but read-back fails → retry pin, then fail job with `ARTIFACT_UNAVAILABLE`
- Kubo daemon not running → fail job with `WORKER_INTERNAL_ERROR`
- NAT/firewall prevents external retrieval → worker uses HTTP upload to coordinator's IPFS node (D5 decision)

**Acceptance:**
- `output_cid` is a real IPFS CID (starts with `Qm` or `bafy`)
- Read-back verification passes before submission
- Artifact ref validates against `artifact_ref.json` schema
- Failure modes tested (daemon down, read-back mismatch)

---

### Step 0.3 — Server-Side Nonce + Dedup (HivePoA)

**What:** HivePoA generates `job_nonce` on job creation, validates echo on submission, enforces scoped SHA-256 dedup.

**Current state:** No nonce field in `computeJobs` table. No dedup tracking. `error_codes.json` defines `JOB_NONCE_MISMATCH` and `DEDUP_REJECTION` but neither is implemented.

**Changes:**

**A) Nonce generation (job creation):**
```typescript
// In createComputeJob():
const jobNonce = crypto.randomBytes(16).toString('hex'); // 32 chars, matches minLength: 16
// Store in manifestJson alongside other manifest fields
// Return in claim response so worker can echo it
```

**B) Nonce validation (result submission):**
```typescript
// In submitResult():
const provenance = JSON.parse(resultJson).provenance;
if (provenance?.job_nonce !== job.manifestJson.job_nonce) {
  return { error_code: 'JOB_NONCE_MISMATCH' };
}
```

**C) Scoped SHA-256 dedup (separate from idempotency):**
```typescript
// New table or index for artifact tracking
// Per-workload scoping:
//   data_generation + domain_lora_train: reject cross-job identical SHA-256
//   eval_sweep + benchmark_run: allow identical (deterministic jobs)
```

**D) Idempotency (separate from dedup):**
```typescript
// Same (job_id, attempt_id, lease_token) resubmit → return previous result
// Different attempt_id with same SHA-256 → check dedup rules
```

**Files:**
| Repo | File | Change |
|------|------|--------|
| HivePoA | `shared/schema.ts` | Add `jobNonce` column to `computeJobs`, add `computeArtifactFingerprints` table |
| HivePoA | `server/storage.ts` | Add nonce to `createComputeJob()`, add `checkArtifactDedup()` method |
| HivePoA | `server/services/compute-service.ts` | Nonce validation in `submitResult()`, dedup check, structured rejection |
| HivePoA | `server/routes.ts` | Include `job_nonce` in claim response manifest |
| HivePoA | `server/__tests__/schema-conformance.test.ts` | Tests for nonce echo, dedup rejection |

**New table: `computeArtifactFingerprints`**
```sql
id             SERIAL PRIMARY KEY
job_id         UUID NOT NULL REFERENCES compute_jobs(id)
attempt_id     UUID NOT NULL REFERENCES compute_job_attempts(id)
workload_type  TEXT NOT NULL
output_sha256  TEXT NOT NULL
created_at     TIMESTAMP DEFAULT NOW()
-- Unique constraint per workload scope:
-- UNIQUE(workload_type, output_sha256) WHERE workload_type IN ('data_generation', 'domain_lora_train')
```

**Acceptance:**
- Every created job has a `job_nonce` (32+ hex chars)
- Worker echo of wrong nonce → `JOB_NONCE_MISMATCH` rejection
- Duplicate SHA-256 for data_generation → `DEDUP_REJECTION`
- Duplicate SHA-256 for eval_sweep → accepted (deterministic)
- Same (job_id, attempt_id, lease_token) resubmit → idempotent (return previous result)
- Idempotency and dedup are separate DB structures

---

### Step 0.4 — Retry-Safe State Transitions + Durable Checkpoints

**What:** Worker maintains durable local state for crash recovery. Server enforces ownership and settlement idempotency.

**A) Worker checkpoint state machine:**

Persisted to `~/.hiveai/checkpoints/{job_id}.json`:
```json
{
  "job_id": "uuid",
  "attempt_id": "uuid",
  "lease_token": "...",
  "state": "artifact_pinned",
  "output_path": "/tmp/eval_xxx.json",
  "output_cid": "QmXxx...",
  "output_sha256": "abc...",
  "provenance": { ... },
  "updated_at": "2026-03-16T12:00:00Z"
}
```

States: `claimed → started → artifact_materialized → artifact_pinned → artifact_verified → provenance_sealed → submit_attempted → submit_acknowledged`

Recovery logic: on worker restart, scan checkpoint dir, resume from last durable state.

**B) Server-side guards:**

```typescript
// Submit endpoint:
// 1. Verify attempt.state allows submission (not already accepted/rejected)
// 2. Verify lease_token matches (ownership check)
// 3. Verify job is still claimed by this worker (not reclaimed after lease expiry)
// 4. If already submitted with same content → return previous result (idempotent)

// Settlement endpoint:
// 1. Only transition payouts from "pending" → "queued" (not re-transition "queued")
// 2. Return success even if already settled (idempotent)
// 3. Server is authoritative — worker retries blindly
```

**C) Settlement idempotency fix:**

Current `settlePayouts()` filters `status = 'pending'` — this is already partially idempotent (won't re-transition "queued" payouts). But needs explicit: if 0 pending payouts, return success with `already_settled: true`.

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/worker.py` | Add checkpoint write/read/resume logic |
| Hive-AI | `hiveai/compute/checkpoints.py` | **NEW** — Checkpoint state machine + persistence |
| HivePoA | `server/services/compute-service.ts` | Ownership guard on submit, idempotent settlement |
| HivePoA | `server/routes.ts` | Return `already_settled` flag on duplicate settle |

**Acceptance:**
- Worker crash after `artifact_pinned` → restart → resumes from pinned state, submits
- Duplicate submit with same content → server returns previous result
- Duplicate settle → server returns success with `already_settled: true`
- Submit after lease expiry → server rejects with ownership error (per D3/GC decision)
- No duplicate payouts under any scenario

---

### Step 0.5b — Structured Observability

**What:** Every protocol-significant action emits a structured event with full correlation keys.

**Event schema:**
```typescript
interface ComputeEvent {
  event_type: string;       // "claim_issued", "submit_accepted", "dedup_rejection", etc.
  timestamp: string;        // Server-issued ISO 8601
  job_id: string;
  attempt_id?: string;
  worker_id?: string;
  node_instance_id?: string;
  nonce?: string;
  artifact_sha256?: string;
  artifact_cid?: string;
  schema_version: number;
  details?: Record<string, unknown>;
}
```

**12 event types:**
| Event | Emitted by | When |
|-------|-----------|------|
| `claim_issued` | Server | Job claimed by worker |
| `nonce_issued` | Server | Job created with nonce |
| `artifact_cid_claimed` | Server | Worker submits with CID |
| `artifact_cid_verified` | Server | Coordinator retrieves + verifies CID |
| `artifact_cid_failed` | Server | Coordinator cannot retrieve CID |
| `submit_attempt_received` | Server | Submit endpoint called |
| `submit_accepted` | Server | Verification passed |
| `submit_rejected` | Server | Verification or policy failed |
| `settlement_attempted` | Server | Settle endpoint called |
| `settlement_deduplicated` | Server | Already settled, no-op |
| `ownership_mismatch` | Server | Stale worker tries to submit |
| `replay_rejection` | Server | Nonce mismatch |
| `dedup_rejection` | Server | SHA-256 duplicate for scoped workload |

**Files:**
| Repo | File | Change |
|------|------|--------|
| HivePoA | `server/services/compute-service.ts` | Emit events at each transition point |
| HivePoA | `server/logger.ts` | Add `logComputeEvent()` with structured format |
| HivePoA | `server/__tests__/` | Verify events emitted for each scenario |

**Acceptance:** Every fault injection scenario (Step 0.6) produces a traceable event chain joinable by `job_id + attempt_id`.

---

### Step 0.6 — Fault Injection Tests

**What:** Prove transaction integrity under adversarial conditions.

**Single-fault scenarios (7):**
| # | Scenario | Expected behavior |
|---|----------|-------------------|
| F1 | Crash after artifact creation, before pin | Worker restarts, re-pins from local file |
| F2 | Crash after pin, before submit | Worker restarts, re-submits with existing CID |
| F3 | Submit timeout, unknown server receipt | Worker retries, server returns idempotent result |
| F4 | Duplicate submit after server accept | Server returns previous acceptance |
| F5 | fail_job() races with submit_result() | Server accepts first arrival, rejects second |
| F6 | Reclaim while stale worker retries submit | Server rejects stale lease_token |
| F7 | IPFS retrieval timeout during verification | Job enters `verification_pending`, retries 3x, then `artifact_unavailable` |

**Compound-fault scenarios (3):**
| # | Scenario | Expected behavior |
|---|----------|-------------------|
| C1 | Submit timeout + server accepted + worker crash before checkpoint | Worker restarts, retries submit, server returns idempotent acceptance |
| C2 | Artifact pinned locally + verification timeout + lease expiry + reclaim | Original worker's submit rejected (ownership), new worker claims fresh |
| C3 | Old worker retry + new worker submit + same artifact hash + different claims | Second submit rejected (dedup for training) or accepted (eval), no double-pay |

**Ambiguous-success scenarios (2):**
| # | Scenario | Expected behavior |
|---|----------|-------------------|
| A1 | Server accepted submit, response lost, worker retries | Server returns same acceptance, no duplicate state |
| A2 | Settlement committed, ack lost, coordinator retries | Server returns `already_settled: true`, no duplicate payout |

**Files:**
| Repo | File | Change |
|------|------|--------|
| HivePoA | `server/__tests__/compute-fault-injection.test.ts` | **NEW** — All 12 scenarios |
| Hive-AI | `tests/test_compute_faults.py` | **NEW** — Worker-side fault recovery tests |

**Acceptance:** All 12 scenarios pass. Event traces are joinable for every scenario.

---

### Step 0.7 — Pydantic Models from Proven Schemas

**What:** Generate typed Python models FROM the proven JSON Schemas. Schema remains source of truth.

**Why last:** Schemas are now proven in both languages. Runtime code is proven under faults. Only now is it safe to add convenience wrappers without risk of them becoming a shadow source of truth.

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/schema_models.py` | **NEW** — Pydantic v2 models matching each schema |
| Hive-AI | `tests/test_schema_models.py` | **NEW** — Verify Pydantic models accept/reject same fixtures as jsonschema |

**Acceptance:** Pydantic models produce identical pass/fail on all 14 canonical fixtures.

---

## Phase 1 — Data Generation Jobs

**Prerequisite:** Phase 0 complete (all completion criteria met).

### Step 1.1 — Pair Generator Executor

**What:** Worker-side executor that generates training pairs for weak domains using a pinned generator model.

**Manifest contract** (from `manifest_data_generation.json`):
- `domain`: one of python, rust, go, cpp, javascript, hive
- `pair_count`: 1-500
- `generator_model_allowlist`: e.g. `["qwen3:14b"]`
- `quality_threshold`: 0.0-1.0
- `prompt_template`: "weakness_targeted"
- `max_wall_clock_seconds`: 60-7200

**Output:** JSONL file with `{instruction, response}` pairs → IPFS artifact.

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `scripts/gen_pairs_worker.py` | **NEW** — Pair generator (wraps existing `improve.py` weakness-targeted generation) |
| Hive-AI | `hiveai/compute/worker.py` | Add `_execute_data_generation()` method |
| Hive-AI | `hiveai/compute/models.py` | Add `DataGenerationManifest` + `DataGenerationResult` dataclasses |

**Acceptance:** Worker generates 50 pairs, uploads JSONL to IPFS, submits with provenance. Result validates against `result_data_generation.json` schema.

---

### Step 1.2 — Data Generation Verifier

**What:** Layered verification for generated training data.

**Verification layers:**
| Layer | Check | Cost |
|-------|-------|------|
| Structural | JSONL parse, required fields, line count | Cheap |
| Corpus | Exact + near-duplicate detection (hash + trigram) | Medium |
| Corpus | Refusal/template boilerplate detection | Cheap |
| Corpus | Repetition + length-distribution anomaly | Cheap |
| Corpus | Domain keyword validation | Cheap |
| Semantic | 10% sampled quality scoring via coordinator model | Expensive |
| Provenance | `job_nonce` echo + `output_sha256` dedup | Cheap |

**Decision:** PASS if all structural/corpus checks pass AND sampled quality ≥ 70%.

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/verifier.py` | Add `DataGenerationVerifier` class |
| Hive-AI | `tests/test_compute.py` | Tests for each verification layer |

**Acceptance:** Verifier catches: empty JSONL, duplicate pairs, refusal boilerplate, off-domain content, low-quality pairs. Passes legitimate 50-pair batches.

---

### Step 1.3 — Data Generation Canary

**What:** End-to-end canary: coordinator creates data_generation job → worker generates pairs → verifier validates → settlement.

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `scripts/canary_compute.py` | Add `data_generation` canary flow |

**Acceptance:** Worker generates 50 pairs, passes layered verification, earns HBD.

---

## Phase 1.5 — Adapter Validation

**Prerequisite:** Phase 1 complete.

### Step 1.5.1 — Adapter Validation Executor

**What:** Worker downloads an existing adapter from IPFS, loads it onto base model, runs quick eval, submits scores.

**Flow:**
1. Coordinator uploads known adapter to IPFS
2. Creates `adapter_validation` job with adapter CID + eval manifest
3. Worker downloads adapter via `download_artifact(cid)`
4. Loads adapter onto base model (Unsloth/PEFT)
5. Runs quick 18-probe eval
6. Submits scores with provenance

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/worker.py` | Add `_execute_adapter_validation()` method |
| Hive-AI | `hiveai/compute/verifier.py` | Add `AdapterValidationVerifier` (compares against coordinator's own eval) |

**Acceptance:** Worker loads adapter, runs eval, result verified. Reputation gate: workers must pass this to unlock micro-training.

---

## Phase 1.75 — Micro-Training Canary

**Prerequisite:** Phase 1.5 complete (adapter_validation working).

### Step 1.75.1 — Micro-Training Gate

**What:** Before paid training, workers must pass a 100-step micro-training canary to prove training stability (catches OOMs, disk issues, checkpoint corruption under backward pass that don't appear during inference-only adapter_validation).

**Flow:**
1. Coordinator creates `domain_lora_train` job with `max_steps: 100` and minimal budget
2. Worker trains 100 steps using `train_v5.py`/`train_domain.py`
3. Submits adapter artifact
4. Verifier loads adapter + runs quick eval
5. PASS → reputation upgraded to "training-capable"
6. FAIL → remains at adapter_validation tier

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/worker.py` | `_execute_domain_lora_train()` with step cap detection |
| HivePoA | `server/services/compute-service.ts` | Reputation upgrade on micro-training pass |

**Acceptance:** Worker trains 100 steps, submits adapter, verifier confirms quality. Worker unlocks full training jobs.

---

## Phase 2 — Domain LoRA Training Jobs

**Prerequisite:** Phase 1.75 complete (worker has "training-capable" reputation).

### Step 2.1 — Training Executor

**What:** Workers train domain-specific LoRA adapters and upload adapter weights to IPFS.

**Gating:** reputation ≥ 5 AND passed micro-training canary.

**Output must include:**
- `adapter_model.safetensors`
- `adapter_config.json`
- `training_log.json` (loss curve, lr schedule, wall time)
- Provenance metadata (all hashes, seed, hyperparams)

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `scripts/train_domain_worker.py` | **NEW** — Wraps `train_v5.py`, outputs adapter + provenance |
| Hive-AI | `hiveai/compute/worker.py` | Wire `_execute_domain_lora_train()` to training executor |
| Hive-AI | `hiveai/compute/verifier.py` | Add `DomainLoraTrainVerifier` (full hidden eval, not sampled) |

**Acceptance:** Worker trains LoRA adapter, passes full hidden eval, earns HBD. Result validates against `result_domain_lora_train.json` schema.

---

### Step 2.2 — Docker Containerization

**What:** Training workloads run in Docker containers for isolation. Eval/benchmark remain subprocess-based (low risk).

**Why here:** Training jobs execute arbitrary model code with GPU access. Subprocess isolation is insufficient for untrusted training workloads.

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/container.py` | **NEW** — Docker job executor (GPU passthrough, volume mounts, timeout) |
| Hive-AI | `Dockerfile.worker` | **NEW** — Training job container image |

**Acceptance:** Training job runs inside Docker with `--gpus all`, adapter output extracted, container cleaned up.

---

## Phase 3 — Adapter Aggregation

**Prerequisite:** Phase 2 complete, 2+ adapters available from different workers.

### Step 3.1 — Dense-Delta + SVD Merge

**What:** Coordinator merges multiple LoRA adapters into one improved adapter.

**Algorithm (prototype, replaceable):**
```python
deltas = [adapter.B @ adapter.A for adapter in adapters]
improvements = [a.domain_score - baseline.domain_score for a in adapters]
weights = normalize([clip(imp / max(improvements), 0.1, 2.0) for imp in improvements])
merged_delta = sum(w * d for w, d in zip(weights, deltas))
U, S, Vh = svd(merged_delta)
new_B = U[:, :rank] @ diag(sqrt(S[:rank]))
new_A = diag(sqrt(S[:rank])) @ Vh[:rank, :]
```

**Monitor:** `discarded_residual_norm = ||merged_delta - new_B @ new_A||` — when this exceeds threshold, switch to FedEx-LoRA (Phase 4).

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/aggregator.py` | **NEW** — Dense-delta + SVD merge with admission control |
| Hive-AI | `scripts/merge_adapters.py` | **NEW** — CLI for adapter aggregation |

---

### Step 3.2 — Baseline Registry + Round Manifest

**What:** Every merged adapter version is recorded with full provenance for regression forensics.

**Registry entry** (from `baseline_registry_entry.json` schema):
- version, parent_version, merged_at
- contributing_job_ids, contributing_workers, dataset_cids
- merge_algorithm, merge_rank, discarded_residual_norm
- eval_scores, overall_score, baseline_improvement
- adapter_cid, adapter_sha256

**Storage:** Off-chain coordinator DB for speed. Periodically anchor to Hive via `custom_json` with registry root hash (D6).

**Admission control:** Must pass hidden eval, must be non-dominated on at least one domain, must not regress core baseline beyond 3%.

**Files:**
| Repo | File | Change |
|------|------|--------|
| HivePoA | `shared/schema.ts` | Add `baselineRegistry` table |
| HivePoA | `server/services/compute-service.ts` | Baseline registration + Hive anchoring |
| Hive-AI | `hiveai/compute/aggregator.py` | Admission control logic |

**Acceptance:** 2 training jobs → curated merge → evaluate → new baseline registered with full provenance.

---

### Step 3.3 — Post-Merge Weakness-Hunter Flywheel

**What:** After every successful merge, automatically run `weakness_hunter.py` against the merged brain to find remaining weak domains, then create `data_generation` jobs targeting those weaknesses. This closes the improvement loop: merge → eval → find weaknesses → generate targeted pairs → feed next training round.

**Why this matters:** Without this hook, data generation and training are manually sequenced. With it, each merge round automatically produces the curriculum for the next round. The improvement compounds: more miners = smarter curriculum, not just more compute. This is the difference between "federated training" and "federated evolution."

**What already exists:**
- `scripts/weakness_hunter.py` (577 lines) — finds weak domains via probe analysis
- `scripts/weakness_trend.py` (327 lines) — tracks weakness trends over time with provenance stamps
- `scripts/improve.py` (615 lines) — weakness-targeted pair generation
- Phase 1 `data_generation` jobs — workers generate pairs from weakness profiles

**The missing connection:** `weakness_hunter.py` output → `data_generation` job manifest creation. Currently these are manual standalone scripts. The hook wires them into the aggregation loop.

**Flow:**
1. Phase 3 merge completes → new baseline registered
2. Coordinator runs `weakness_hunter.py` against merged adapter
3. Weakness profile identifies 3-5 weakest domains
4. Coordinator auto-creates `data_generation` jobs for each weak domain
5. Workers generate targeted pairs → Phase 1 verification → corpus grows
6. Next training round uses enriched corpus → next merge → repeat

**Safeguards (all mandatory, not aspirational):**

1. **30% human-seed hard floor** — enforced per training batch, not corpus-level. Every dataset shard must contain ≥30% human-authored pairs. Checked at shard construction time, not retroactively.

2. **Novelty filter** — generated pairs must pass dedup against the existing corpus before entering the training pipeline. Exact match + trigram near-duplicate detection (same infrastructure as Phase 1 `DataGenerationVerifier`). Weakness-hunter output that duplicates prior generated tasks is discarded, not amplified.

3. **Eval firewall** — strict separation between "data used to improve the model" and "data used to prove the model improved." Generated pairs feed the training corpus. The hidden eval set used for verification/admission control is NEVER derived from weakness-hunter output. If this line blurs, the flywheel becomes a reward-hacking loop — the model optimizes for its own discovered failure surface rather than the real distribution.

4. **Severity requires persistence, not one spike** — a domain must be classified as stuck or regressing across at least 2 consecutive measurement windows before triggering job creation. Single-round dips do not trigger. This prevents oscillation: without persistence, the flywheel churn-spawns jobs off temporary noise, over-corrects, then swings back. Treat this as a control-loop problem, not a routing rule.

5. **Token/example budget per round** — generated-job quotas are budgeted by total examples, not just job count. A round might create 3 jobs of 50 pairs each (150 pairs total), not 10 jobs. Budget scales with corpus size to prevent synthetic data from dominating. Cap: auto-generated pairs per round ≤ 20% of current corpus size.

6. **Novelty measured against recent auto-generated tranche too** — dedup checks against both the historical corpus AND the most recent auto-generated batch. Without this, duplicate pressure reappears one generation hop later — the same weakness produces the same generated pairs across rounds.

**Observable invariants (without these, safeguards are conceptual):**
- Human-seed floor: measured and logged at shard construction time
- Novelty filter: rejection count emitted per round (observability event)
- Severity threshold: explicit spawn/no-spawn reason logged per domain per round
- Budget cap: total auto-generated examples vs corpus size ratio logged per round

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/aggregator.py` | Add `post_merge_weakness_scan()` with persistence check + budget cap + observability |
| Hive-AI | `scripts/weakness_hunter.py` | Add `--output-manifest` flag to emit `data_generation` job manifests |
| Hive-AI | `scripts/weakness_trend.py` | Add `is_persistent(domain, window=2)` query for severity persistence |
| Hive-AI | `scripts/canary_coordinator.py` | Add `auto-generate` subcommand with example budget enforcement |
| Hive-AI | `hiveai/compute/sharding.py` | Enforce 30% human-seed floor per shard at construction time |

**Acceptance:** Merge completes → weakness scan runs → only persistent stuck/regressing domains selected → novelty-filtered against corpus + recent auto-generated → example budget enforced → 30% human-seed floor verified per shard → all decisions logged with reasons → corpus grows without oscillation or self-training collapse.

---

## Phase 4 — Federated Loop (Deferred)

**Do NOT start until:**
- Phase 0-2 have stable artifact handling and verifier telemetry
- 3+ reliable workers with established reputation
- Dataset ≥ 50k pairs
- Merge evaluation harness can detect regressions across rounds

**When ready:** Coordinator shards dataset → workers train from current best adapter → collect, curate, merge, evaluate → publish if improved → re-shard each round.

### Step 4.1 — Block-Hash-Seeded Shard Assignment

**What:** Dataset shards assigned deterministically using `hash(block_hash + worker_account)` as the randomness seed. Both worker and coordinator can independently compute which shard a worker should get.

**Why this matters:** Without verifiable randomness, the coordinator could assign easy shards to favored workers or hard shards to competitors. Block-hash seeding makes shard assignment deterministic and auditable — any observer can verify the assignment was fair by checking the Hive block hash at the round's reference block.

**Implementation:**
```python
import hashlib

def assign_shard(block_hash: str, worker_account: str, num_shards: int) -> int:
    """Deterministic, verifiable shard assignment. Both sides compute independently."""
    seed = hashlib.sha256(f"{block_hash}:{worker_account}".encode()).digest()
    return int.from_bytes(seed[:4], 'big') % num_shards
```

**Properties:**
- Deterministic: same inputs always produce same shard
- Verifiable: anyone with the block hash can audit assignments
- Fair: SHA-256 is uniformly distributed
- Manipulation-resistant: block hash is not known until block is produced

**Required assumptions (must be specified alongside the scheme):**

1. **Block finality** — Reference block must be from a finalized point in the chain, not a head block subject to reorgs. Hive has 3-second blocks with irreversibility after ~45 seconds (15 blocks). Use a block at least 20 blocks behind head as the reference. The reference block number is announced by the coordinator when the round opens, not chosen retroactively.

2. **Epoch timing** — The reference block is fixed BEFORE claims open. Sequence: coordinator announces round with reference block number → workers register for round → shard assignments computed from the now-known block hash. If the block hash is known before workers decide whether to participate, the scheme is fair. If workers can choose whether to participate AFTER seeing their shard assignment, they can selectively drop unfavorable shards.

3. **Anti-grinding (economic invariant)** — `hash(block_hash + worker_account)` is deterministic but only manipulation-resistant if identity cost exceeds expected grinding profit. The true security condition is:

   > expected gain from a favorable shard < cost of grinding to find one

   Current cost: ~3 HIVE per account + reputation buildup (D2: must pass eval + adapter_validation + micro-training before training jobs = days of real compute). If the network later introduces higher-value shards or asymmetric rewards, this assumption can silently break even if the algorithm stays the same. **Monitor:** track the ratio of shard value to identity cost. If shard value rises significantly, add additional anti-sybil measures (stake requirement, longer reputation window).

4. **Registration freeze** — Workers must register for a round before the reference block is produced. Late registration after the block hash is known would allow selective participation. The round manifest should specify: `registration_deadline_block < reference_block`.

5. **Use irreversibility, not delay** — "20 blocks behind head" is a folk proxy for finality. The actual requirement is an irreversible block. Hive provides `last_irreversible_block_num` via the API. Use that, not a fixed offset. The implementation should call `get_dynamic_global_properties()` and use `last_irreversible_block_num` as the floor for reference block eligibility.

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/sharding.py` | **NEW** — `assign_shard()` + `verify_assignment()` with finality check (~50 lines) |
| Hive-AI | `hiveai/dbc/chain.py` | Add `get_reference_block_hash(block_num)` with irreversibility check |

**Acceptance:** Given a finalized block hash and worker account, both coordinator and worker independently compute the same shard assignment. Late-registered workers rejected. Reference block announced before registration opens.

---

### Step 4.2 — DiLoCo Evaluation (Research Note)

**What:** DiLoCo (Distributed Low-Communication Optimization, Google 2023) is an alternative to FedEx-LoRA for Phase 4's federated aggregation. Workers train for hundreds of local steps with full local momentum before syncing, using ultra-low-rank gradient sketches for communication.

**Why worth evaluating:** Our worker model (untrusted, may drop out, heterogeneous GPUs, unreliable connectivity) is exactly the scenario DiLoCo was designed for. It tolerates:
- Workers training for many steps independently (matches our long-lease model)
- Dropout without coordination overhead (workers that disappear are simply missing from the next sync)
- Heterogeneous hardware (8-48 GB cards all participate meaningfully)
- Near-zero networking between sync points

**Current plan:** D3 specifies Dense-delta SVD for Phase 3, FedEx-LoRA for Phase 4. DiLoCo is a candidate to evaluate alongside FedEx-LoRA when Phase 4 begins.

**Critical framing: these solve different problems.**

The real decision is not "which paper looks better" but "what problem Phase 4 is actually solving":

- **FedEx-LoRA** solves: exact adapter aggregation in a federated LoRA regime. It pushes residual information into frozen base weights instead of discarding it during rank truncation. Best when: adapters are the unit of exchange, communication is affordable, exactness matters.
- **DiLoCo** solves: low-communication training across poorly connected workers. Workers run hundreds of local SGD steps with full momentum, then sync via ultra-low-rank gradient sketches (~500× less communication than synchronous training). Best when: network is unreliable, workers are heterogeneous, dropout is common.

Our worker model (untrusted, may drop out, heterogeneous GPUs, 8-48 GB, unreliable connectivity) matches DiLoCo's design assumptions more closely. But FedEx-LoRA's exactness property matters if adapter quality is the bottleneck.

One 2026 follow-on analysis (arXiv 2502.15436) argues FedEx-LoRA's residual mechanism weakens communication efficiency because the residual grows beyond low-rank communication — relevant if our workers have limited upload bandwidth.

**Decision criteria:**

| Factor | FedEx-LoRA | DiLoCo |
|--------|-----------|--------|
| Communication cost | Medium (full adapter per round) | Very low (gradient sketch only) |
| Residual handling | Pushes residual into frozen weights | Momentum handles it implicitly |
| Dropout tolerance | Good (missing adapters excluded) | Better (local steps continue) |
| Implementation complexity | Medium (SVD + residual carry) | Lower (optimizer + sync wrapper) |
| Mathematical exactness | Exact under assumptions | Approximate but convergent |
| Network requirements | Adapter upload per round | Rare low-rank sync |
| Maturity | Published 2024 (arXiv 2410.09432) | Published 2023 (arXiv 2311.08105), OpenDiLoCo replication 2024 (arXiv 2407.07852) |

**Action:** When Phase 4 begins, benchmark both on a small-scale (3-worker, 5k-pair) federated round before committing. The evaluation harness from Phase 3 (merge → eval → baseline registry) provides the comparison infrastructure.

**The real decision variable is wall-clock to target quality under dropout and real network conditions** — not just final quality or communication bytes in isolation. A method that produces a better adapter but takes 3× longer under real worker dropout is worse for this system.

**Benchmark criteria (all measured, not estimated):**

- Final adapter quality (eval scores vs baseline)
- Total communication bytes per round
- Wall-clock time to reach target quality threshold
- Behavior under 1-of-3 worker dropout mid-round
- Recovery behavior when a dropped worker rejoins next round

**No implementation files yet.** This is a research note for Phase 4 scoping. The choice is an architecture fork, not a library swap — it determines how workers interact with the coordinator for the entire federated loop.

---

## Phase UX — Worker Experience

**Can be done in parallel with Phase 1+ (no dependency on Phase 0 beyond basic worker).**

### UX.1 — Zero-Config GPU Auto-Detection

**What:** Worker auto-detects GPU model, VRAM, CUDA version on first run. No `--gpu-model` or `--gpu-vram` CLI flags needed.

**Current state:** `scripts/gpu_worker.py` has `--gpu-model` and `--gpu-vram` as required args. CUDA auto-detection exists but only as fallback.

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/hardware.py` | Already exists — verify GPU detection coverage |
| Hive-AI | `scripts/gpu_worker.py` | Make GPU args optional, auto-detect by default |

**Acceptance:** `python scripts/gpu_worker.py --hivepoa-url X --api-key Y` with no GPU args → correctly detects and registers.

---

### UX.2 — Background Daemon Mode

**What:** Worker runs as a background service, not a foreground script.

**Current state:** `scripts/gpu_worker.py` runs in foreground, blocks terminal.

**Target:** systemd service (Linux), Windows Service or tray app (Windows), launchd (macOS).

**Files:**
| Repo | File | Change |
|------|------|--------|
| Hive-AI | `scripts/gpu_worker.py` | Add `--daemon` flag with PID file + log rotation |
| Hive-AI | `hiveai/compute/daemon.py` | **NEW** — Platform-specific daemonization |
| Hive-AI | `gpu-worker.service` | **NEW** — systemd unit file |

---

### UX.3 — Electron Desktop Agent Integration

**What:** GPU worker bundled into the Electron desktop agent alongside Kubo IPFS daemon.

**Current state:** Electron app exists for HivePoA desktop agent with bundled Kubo. GPU worker is a separate Python process.

**Target:** Electron app manages both Kubo daemon and GPU worker as child processes. UI shows worker status, earnings, reputation.

**This is a larger integration task — scope after Phase 2 is stable.**

---

## Dependency Graph

```
Step 0.0 (fix tests)
  └─→ Step 0.5 (design decisions)
        └─→ Step 0.1 (provenance) ──────────────────────┐
        └─→ Step 0.2 (IPFS artifacts) ──────────────────┤
        └─→ Step 0.3 (nonce + dedup) ───────────────────┤
              └─→ Step 0.4 (retry-safe + checkpoints) ──┤
                    └─→ Step 0.5b (observability) ───────┤
                          └─→ Step 0.6 (fault injection) ┤
                                └─→ Step 0.7 (Pydantic) ─┘
                                      │
                                      ▼
                              Phase 0 COMPLETE
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 │                   ▼
              Phase 1              UX.1-2            (parallel)
           (data_generation)    (auto-detect,
                    │            daemon mode)
                    ▼
              Phase 1.5
           (adapter_validation)
                    │
                    ▼
              Phase 1.75
           (micro-training canary)
                    │
                    ▼
              Phase 2
           (domain_lora_train + Docker)
                    │
                    ▼
              Phase 3
           (aggregation + baseline registry
            + weakness-hunter flywheel)
                    │
                    ▼
              Phase 4 (deferred)
           (block-hash sharding
            + DiLoCo vs FedEx-LoRA eval)
```

---

## Phase 0 Completion Criteria (from control document)

- [ ] Every job result carries structured provenance (identity + environment + derivation)
- [ ] Artifacts go to IPFS with verified retrieval before trust
- [ ] Replay prevented via exact nonce binding (single chosen tuple)
- [ ] Idempotency and dedup are separate mechanisms, both enforced, in separate DB structures
- [ ] Repeated submit for same completed job is side-effect free
- [ ] Repeated settle for same accepted result is side-effect free
- [ ] Artifact CID is verified against the chosen trust authority before settlement
- [ ] Worker crash at any point after artifact creation can resume or fail closed without duplicate payout
- [ ] Server can explain rejection reason deterministically for replay, dedup, version mismatch, and ownership
- [ ] Claim ownership is verified at submit time
- [ ] Late-work policy is implemented and tested (not deferred)
- [ ] Fault injection tests cover all 7 single-fault, 3+ compound-fault, AND 2+ ambiguous-success scenarios
- [ ] Structured observability events exist for every protocol-significant action with full correlation keys
- [ ] Acceptance and settlement are distinct thresholds (not collapsed)
- [ ] Time authority is server-side; worker timestamps are advisory only
- [ ] Mixed-version behavior is explicitly tested or gated
- [ ] Both repos validate same schema fixtures in CI

---

## Review Findings — Combined Claude + GPT Falsification (2026-03-16)

16 findings from two independent reviews. All fixes are constraint tightenings, not redesigns.

### Fix 1: Separate enforcement invariants from monitoring invariants

**Problem:** The plan treats all invariants as equally protective. Some naturally fail closed (human-seed floor, novelty dedup, nonce echo). Others naturally drift to monitor-only (shard-value ratio, anti-oscillation signals, benchmark telemetry). If not separated, operators assume all are equally protective when they are not.

**Fix:** Classify every invariant explicitly:

| Invariant | Type | Fail behavior |
|-----------|------|---------------|
| 30% human-seed floor per shard | **Enforcement** | Shard builder refuses to emit — blocks job creation |
| Novelty/dedup filter | **Enforcement** | Pair rejected — not added to corpus |
| Eval firewall | **Enforcement** | Generated pair CIDs excluded from hidden eval set construction |
| Example budget cap (20%) | **Enforcement** | Job creation blocked when budget exhausted |
| Per-domain concentration cap (NEW) | **Enforcement** | No domain gets >40% of auto-generated budget — excess jobs not created |
| Nonce echo | **Enforcement** | Submit rejected with `JOB_NONCE_MISMATCH` |
| Registration freeze | **Enforcement** | Late registration rejected |
| Schema version mismatch | **Enforcement** | Submit rejected with `MANIFEST_VERSION_UNSUPPORTED` |
| Shard-value-to-identity-cost ratio | **Monitoring** | Alert at threshold, human review required |
| Anti-oscillation persistence | **Monitoring → Enforcement** | Persistence check gates job creation, but window calibration is monitored |
| Benchmark telemetry | **Monitoring** | Logged for decision, does not block |
| Observability event emission | **Monitoring** | Missing events flagged in CI, not blocking in production |

**Rule:** Enforcement invariants block the action. Monitoring invariants trigger escalation. Never confuse the two in implementation.

---

### Fix 2: Define measurement window as system event, not time

**Problem:** "2+ measurement windows" is undefined. If windows are wall-clock, they decouple from system activity. If too short, noise survives. If too long, regressions go stale.

**Fix:** A measurement window = one completed merge-and-eval cycle, regardless of wall-clock duration. Persistence means the domain was classified as stuck or regressing in 2 consecutive completed cycles. Minimum sample mass: each window must include ≥1 full eval run (18+ probes) against the merged adapter.

Add hysteresis: once a domain triggers job creation, it is excluded from re-triggering for 1 additional cycle after improvement is detected. This prevents spawn-improve-drop-respawn oscillation.

---

### Fix 3: Add per-domain concentration cap within auto-generated budget

**Problem:** The 20% corpus-level cap constrains volume but not distribution. All 20% could go to one domain, distorting the training signal.

**Fix:** No single domain may receive more than 40% of the round's auto-generated budget. If weakness-hunter identifies 1 regressing domain but budget allows 150 pairs, cap that domain at 60 pairs (40% of 150). Remaining budget unspent — do not force-fill with lower-priority domains.

This is an **enforcement invariant**: job creation is blocked when the per-domain cap is reached.

---

### Fix 4: Monitor shard-value asymmetry ratio, not just mean

**Problem:** Grinding is driven by tail shard value, not average. If one shard class has much higher expected value, an attacker only needs occasional favorable draws.

**Fix:** Track three metrics:
- `mean_shard_value` — baseline
- `max_shard_value / mean_shard_value` — asymmetry ratio
- `max_shard_value / identity_cost` — grinding profitability

Alert threshold: if asymmetry ratio > 3.0, the sharding scheme needs rebalancing before the next round. This is a **monitoring invariant** that triggers human review, because the fix (rebalancing shard construction) is a design decision, not an automatic action.

Also acknowledge: identity cost is not fixed. Accounts can be bought, pre-aged, or farmed. The reputation requirement (D2) is the real anti-sybil defense, not account creation cost alone. Monitor new-account registration rate as a secondary signal.

---

### Fix 5: Coordinator publishes exact reference block — workers verify, not derive

**Problem:** Different Hive RPC nodes may report different `last_irreversible_block_num` due to propagation delay. If workers independently derive the reference block, they can get different assignments without any reorg.

**Fix:** Commit to model (1) only:
1. Coordinator announces the exact reference block number + hash in the round manifest
2. Workers fetch that specific block's hash from any node (block hashes are deterministic once produced)
3. Workers verify: announced block number ≤ their node's LIB (sanity check that it's finalized)
4. If verification fails (their node hasn't seen that block as irreversible yet), worker waits and retries, not derives independently

Drop any implication that workers independently determine the reference block number.

---

### Fix 6: Mechanically define target quality for Phase 4 benchmark

**Problem:** "Wall-clock to target quality" is only valid if target quality is fixed before the benchmark runs.

**Fix:** Before the benchmark, lock:
- **Eval metric:** 6-domain average on the frozen hidden eval set (same set used for all Phase 2+ admission control)
- **Target Δ:** baseline eval score + 0.02 absolute improvement
- **Stop condition:** first method to reach Δ at any checkpoint wins on wall-clock. If neither reaches it in T hours (T = 2× the expected single-worker training time), neither passes
- **Initialization:** both methods start from the same baseline adapter and same dataset snapshot
- **Dropout schedule:** controlled, identical for both runs (e.g., worker 2 drops at step 500, rejoins at step 1000)
- **Communication accounting:** includes all traffic (adapters, gradients, control messages, rejoin sync)

This prevents post-hoc metric selection. The benchmark is a race to a fixed finish line under identical conditions.

**Confounder defense (from GPT):** both methods must receive equal implementation effort. If one gets a cleaner prototype, the benchmark measures engineering maturity, not architecture suitability. Mitigation: time-box implementation to equal effort, or acknowledge the confounder explicitly in results.

---

### Fix 7: Specify semantic sampling authority for Phase 1 verification

**Problem (Claude only):** The DataGenerationVerifier's "10% sampled quality scoring via coordinator model" has no specified model, sampling method, or contestability.

**Fix:**
- **Model:** coordinator uses the same base model (Qwen2.5-Coder-14B) with the current best adapter, not the same model workers used for generation. This prevents self-evaluation.
- **Sampling:** random 10% of pairs, seed derived from `job_nonce` (deterministic, reproducible).
- **Threshold:** average quality ≥ 0.7 across sampled pairs. Quality = coordinator model scores each pair on instruction clarity + response correctness (0.0-1.0).
- **Contestability:** not in v1. Workers cannot contest quality scores. If false rejection rate is problematic, increase sample size, don't add appeal logic.

---

### Fix 8: Worker checkpoint recovery must check server state first

**Problem (Claude only):** Worker crashes, restarts after >2 minutes, lease has expired, job re-queued and claimed by someone else. Worker's checkpoint says `artifact_pinned`. Server says `timed_out → re-queued → claimed_by_other`.

**Fix:** Worker recovery logic:
1. Read checkpoint from `~/.hiveai/checkpoints/{job_id}.json`
2. **Before resuming:** call `get_job(job_id)` on server
3. If server says job is still claimed by this worker → resume from checkpoint state
4. If server says job is `timed_out`, `claimed` by another worker, or `completed` → discard checkpoint, log `ownership_lost`, poll for new work
5. Never attempt submit against a job the server says isn't yours

This is the "local checkpoints are advisory, server is authoritative" rule applied to the recovery path, not just the steady-state path.

---

### Fix 9: Enforce homogeneous LoRA rank in Phase 3 admission control

**Problem (Claude only):** The SVD merge algorithm computes `adapter.B @ adapter.A` for each adapter. If adapters have different LoRA ranks, the delta matrices have different factorization dimensions and the weighted average is mathematically undefined.

**Fix:** Phase 3 admission control rejects adapters whose `lora_rank` doesn't match the round's target rank. The manifest already pins `lora_rank` as an enum (8, 16, 32, 64). The round manifest specifies a single target rank. Workers that trained with a different rank are excluded from the merge set.

If heterogeneous ranks are needed later, the alignment strategy (pad with zeros, project to common rank, etc.) must be specified before allowing it.

---

### Fix 10: Fix Steps 0.1/0.3 dependency in the graph

**Problem (Claude only):** Step 0.1 (provenance) requires the worker to echo `job_nonce`. But `job_nonce` doesn't exist until Step 0.3 (nonce generation) adds it to the server. They cannot be fully parallel.

**Fix:** Update dependency graph: Step 0.3A (nonce generation on server) must land before Step 0.1 (provenance wiring on worker). The dedup portion of 0.3 can remain parallel with 0.1/0.2. Split 0.3 into:
- 0.3A: nonce generation + claim response (server) — prerequisite for 0.1
- 0.3B: dedup + artifact fingerprinting (server) — parallel with 0.1/0.2

---

### Fix 11: Single authority for weakness → job conversion (GPT finding)

**Problem (GPT only):** Who converts weakness signals into `data_generation` jobs? If multiple components can independently see a weakness and decide to create jobs, you get duplicate spawns, inconsistent novelty checks, and race conditions.

**Fix:** The coordinator is the sole authority for post-merge job creation. `post_merge_weakness_scan()` is a single synchronous function called once per merge cycle. It reads weakness signals, applies all safeguards (persistence, budget, concentration, novelty), and emits job manifests. No other component creates auto-generated jobs. This is an authority boundary, not a routing decision.

---

### Fix 12: Pin eval/classifier version in weakness-hunter output (GPT finding)

**Problem (GPT only):** Weakness detection is coupled to classifier/version stability. If probe composition, scoring calibration, or evaluation mode changes between rounds, the flywheel reacts partly to measurement drift, not model weakness.

**Fix:** Every weakness-hunter output includes:
- `eval_harness_version`
- `probe_set_hash` (SHA-256 of the probe list used)
- `scoring_version`

Persistence check (Fix 2) compares only within the same `(eval_harness_version, probe_set_hash)` pair. If the harness version changes mid-sequence, the persistence counter resets — the new version must establish its own 2-window baseline before triggering jobs. This prevents version-change artifacts from being misinterpreted as regressions.

---

### Fix 13: Define safeguard conflict resolution order (GPT finding)

**Problem (GPT only):** When safeguards conflict (e.g., severity says "spawn," novelty says "insufficient novelty," human-seed floor can't be satisfied), what is the resolution?

**Fix:** Safeguards are evaluated in priority order. Any enforcement invariant that fails blocks the action, regardless of what other safeguards say:

1. **Budget cap** — if exhausted, stop. No more jobs this round.
2. **Per-domain concentration cap** — if domain is at 40%, skip this domain.
3. **Persistence check** — if domain is not persistent-stuck, skip.
4. **Novelty filter** — if insufficient novel pairs can be generated, skip.
5. **Human-seed floor** — if shard can't be constructed with ≥30% human, skip.

"Skip" means the domain is not targeted this round, not that the safeguard is overridden. The resolution is always "most restrictive wins." Log the skip reason for every domain evaluated.

---

### Fix 14: Benchmark maturity bias defense (GPT finding)

**Problem (GPT only):** Phase 4 benchmark can be invalidated if one candidate gets better implementation quality, more tuning effort, or better restart logic.

**Fix:** Time-box implementation to equal effort for both candidates. Both implementations start from the same codebase (Phase 3 infrastructure). If one method requires significantly more implementation work, that is itself a signal about operational fitness. Document the effort gap explicitly in benchmark results. Do not claim architecture superiority from an engineering quality difference.

---

## Updated Dependency Graph

```
Step 0.0 (fix tests)
  └─→ Step 0.5 (design decisions)
        ├─→ Step 0.3A (nonce generation — server) ──────┐
        │     └─→ Step 0.1 (provenance — needs nonce) ──┤
        ├─→ Step 0.2 (IPFS artifacts) ──────────────────┤
        ├─→ Step 0.3B (dedup — server) ─────────────────┤
        │         └─→ Step 0.4 (retry-safe + checkpoints,
        │               including Fix 8: server-check-first
        │               recovery) ───────────────────────┤
        │               └─→ Step 0.5b (observability) ──┤
        │                     └─→ Step 0.6 (fault injection)
        │                           └─→ Step 0.7 (Pydantic) ─┘
        │                                 │
        │                                 ▼
        │                         Phase 0 COMPLETE
        │                                 │
        │               ┌────────────────┼────────────────┐
        │               ▼                │                 ▼
        │         Phase 1             UX.1-2          (parallel)
        │      (data_generation,   (auto-detect,
        │       Fix 7: semantic     daemon mode)
        │       sampling spec)
        │               │
        │               ▼
        │         Phase 1.5
        │      (adapter_validation)
        │               │
        │               ▼
        │         Phase 1.75
        │      (micro-training canary)
        │               │
        │               ▼
        │         Phase 2
        │      (domain_lora_train + Docker)
        │               │
        │               ▼
        │         Phase 3
        │      (aggregation + baseline registry
        │       + weakness-hunter flywheel
        │       + Fix 9: homogeneous rank gate
        │       + Fixes 1-3, 11-13: flywheel safeguards)
        │               │
        │               ▼
        │         Phase 4 (deferred)
        │      (block-hash sharding + Fixes 4-5
        │       + DiLoCo vs FedEx-LoRA + Fix 6, 14)
```

---

## Execution-Time Watchlist (check during implementation)

1. **Layer collapse** — Each module owns exactly one authority boundary
2. **Soft gates** — Each decision resolves to a persisted shape before Step 1
3. **Timestamp misuse** — Define which server timestamp controls which rule
4. **Operator misreading** — "accepted" must not be interpretable as "payable" in logs/APIs
5. **Indefinite compatibility** — Mixed-version support has an explicit end condition
6. **Settlement-path ambiguity** — Ambiguous-success tests MUST include settlement path
7. **Identity field overloading** — submission_attempt_id ≠ idempotency_key, artifact_hash ≠ completion_id
8. **Green ≠ safe** — Completion criteria are minimum evidence bar, not proof of universal robustness
9. **Enforcement vs monitoring confusion** — Never implement an enforcement invariant as a log-only check (Fix 1)
10. **Checkpoint trust** — Worker recovery always checks server state before resuming (Fix 8)
11. **Single spawning authority** — Only the coordinator creates auto-generated jobs (Fix 11)
12. **Safeguard conflict** — Most restrictive wins, every skip logged with reason (Fix 13)
