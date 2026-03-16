# GPU Sharing Plan — HivePoA Compute Marketplace

## Status: PLAN v2 (revised after systems review)

**Goal:** Anyone with a GPU can contribute compute to the Hive-AI training pipeline and earn HBD. Bittensor-style economics, Hive-native — no separate token, no validator subnet, just HBD via the existing HivePoA treasury/contract system.

**Date:** 2026-03-16 (revised)
**Baseline:** HivePoA `v1.1.0` (sealed at tag `7f4ad10`). Post-release hardening at `a4158a9` (on main, not tagged). Hive-AI compute stack at current main.

> **Clarification:** `v1.1.0` is the sealed tag at `7f4ad10`. `a4158a9` is post-release hardening on main (advisory lock, SQLite parity). Any implementation branch should fork from `a4158a9` on main, not from the `v1.1.0` tag.

---

## What Already Exists (DO NOT REBUILD)

### HivePoA Server (TypeScript/Express)
- 20+ compute endpoints live at `/api/compute/*`
- Atomic job claiming via `SELECT ... FOR UPDATE SKIP LOCKED`
- Lease sweeper — cleans stale leases every 60s
- Node registration with GPU model, VRAM, supported workloads, cached models
- Job lifecycle: create → claim → start → progress → submit → verify → settle
- Three-stage payouts: budget held, verification, then settlement
- Warm-up reputation: new nodes start restricted (eval_sweep, benchmark_run only)
- 6 workload types defined: `eval_sweep`, `benchmark_run`, `adapter_validation`, `domain_lora_train`, `weakness_targeted_generation`, `data_generation`
- Only 2 implemented in the worker: `eval_sweep`, `benchmark_run`

### Hive-AI Worker (Python)
- `GPUWorker` class (413 lines) — registers, polls, claims, executes, heartbeats, submits
- `EvalSweepVerifier` + `BenchmarkRunVerifier` — server-side re-verification (15% tolerance)
- `HivePoAComputeClient` — full REST client for all compute endpoints
- `scripts/gpu_worker.py` — CLI entry point
- `scripts/canary_compute.py` — end-to-end canary with mock mode
- 17 tests covering contracts, worker, verifier, client

### Training/Eval Scripts (available, not all wired to worker)
- `scripts/regression_eval.py` — 60-probe domain eval (WIRED)
- `scripts/executable_eval.py` — code gen + sandbox (WIRED)
- `scripts/train_v5.py` — Unsloth + QLoRA on Qwen2.5-Coder-14B (NOT WIRED)
- `scripts/train_domain.py` — domain-specific LoRA training (NOT WIRED)
- `scripts/improve.py` — weakness-targeted pair generation (NOT WIRED)

---

## Revised Plan: 5 Phases

### Phase 0 — Artifact + Provenance Contract (PREREQUISITE)

**What:** A durable artifact layer that all subsequent workload types depend on. Content-addressed inputs/outputs, provenance metadata, size limits, hash verification.

**Why prerequisite:** Without this, data generation batches and adapter weights become an operational mess. You cannot verify, reproduce, or aggregate what you cannot reliably store, reference, and attribute.

**Components:**

**1. Artifact manifest schema** (added to every job result):
```json
{
  "provenance": {
    "job_id": "uuid",
    "job_nonce": "random-per-job (prevents replay across jobs)",
    "worker_version": "1.2.0",
    "worker_git_sha": "abc123",
    "base_model_sha256": "sha256:...",
    "tokenizer_sha256": "sha256:...",
    "dataset_cid": "QmAbCdEf...",
    "dataset_sha256": "sha256:...",
    "seed": 42,
    "hyperparameters": {"lr": 2e-4, "rank": 32, "epochs": 2},
    "runtime": {
      "cuda_version": "12.4",
      "torch_version": "2.4.0",
      "quantization": "4bit-bnb",
      "platform": "linux-x86_64"
    }
  }
}
```

**2. Artifact storage contract:**
- All outputs > 1 KB go to IPFS (CID is the canonical reference)
- Result JSON contains: `output_cid` (IPFS CID) + `output_sha256` + `output_size_bytes`
- Size limits per workload type:
  - `data_generation`: max 50 MB (JSONL batch)
  - `domain_lora_train`: max 500 MB (adapter tar.gz)
  - `eval_sweep` / `benchmark_run`: max 5 MB (result JSON)
- Retention: pinned for 30 days minimum, then GC unless referenced by active adapter

**3. Replay prevention:**
- Every manifest includes a `job_nonce` (random, assigned by server at creation)
- Worker must echo `job_nonce` in result provenance
- Server rejects results where `output_sha256` was already submitted for a different `job_id`

**4. Capability matching (expanded beyond just VRAM):**
```json
{
  "min_vram_gb": 16,
  "min_disk_free_gb": 50,
  "required_cuda_major": 12,
  "required_base_model": "Qwen/Qwen2.5-Coder-14B-Instruct",
  "required_quantization": "4bit-bnb",
  "max_wall_clock_seconds": 7200,
  "generator_model_allowlist": ["qwen3:14b", "qwen3.5:9b"]
}
```

**Changes needed:**

| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/models.py` | Add `ProvenanceMetadata` dataclass, `ArtifactRef` dataclass |
| Hive-AI | `hiveai/compute/worker.py` | Collect provenance on every job execution, include in result |
| Hive-AI | `hiveai/dbc/compute_client.py` | Add `upload_artifact(path) → cid` using IPFS, `download_artifact(cid) → path` |
| HivePoA | `server/services/compute-service.ts` | Validate `job_nonce` echo, enforce `output_sha256` dedup across jobs |
| HivePoA | `server/routes.ts` | Add `job_nonce` to manifest on job creation |

**Acceptance test:**
1. Create eval_sweep job — manifest includes `job_nonce`
2. Worker submits result with provenance metadata + nonce echo
3. Server accepts
4. Same worker resubmits same `output_sha256` to a different job → rejected
5. Worker submits result with wrong `job_nonce` → rejected

---

### Phase 1 — Data Generation Jobs

**What:** Workers generate training pairs for weak domains. Embarrassingly parallel, no merge complexity.

**Workload type:** `data_generation`

**Generator model constraint:** Manifest specifies a `generator_model_allowlist`. Worker must use a model from the list. This prevents mixed-distribution dataset quality issues. Start with `["qwen3:14b", "qwen3.5:9b"]` — models the coordinator has tested.

**Verification (layered, not just sampling):**

| Check | Layer | Cost |
|-------|-------|------|
| JSONL schema validation | Structural | Cheap — parse every line |
| Required fields present | Structural | Cheap |
| Exact + near-duplicate detection (within batch) | Corpus | Medium — hash + trigram |
| Refusal/template boilerplate detection | Corpus | Cheap — pattern match |
| Repetition + length-distribution anomaly | Corpus | Cheap — stats |
| Domain keyword validator | Corpus | Cheap |
| Sampled quality scoring (10% via coordinator model) | Semantic | Expensive — LLM call |
| `job_nonce` echo + `output_sha256` dedup | Provenance | Cheap |

**Decision:** PASS if all structural/corpus checks pass AND sampled quality ≥ 70%.

**Manifest contract:**
```json
{
  "schema_version": 2,
  "workload_type": "data_generation",
  "job_nonce": "server-assigned-random",
  "domain": "rust",
  "pair_count": 50,
  "generator_model_allowlist": ["qwen3:14b"],
  "server_url": "http://localhost:11434/v1",
  "quality_threshold": 0.7,
  "prompt_template": "weakness_targeted",
  "max_wall_clock_seconds": 1800
}
```

**Payout:** See revised economics below.

---

### Phase 1.5 — Adapter Validation as First-Class Path

**What:** Before training jobs, add `adapter_validation` — workers load an existing adapter and run hidden eval. This is cheaper than training and gives the coordinator confidence in worker capability before trusting them with expensive training jobs.

**Why here:** Warm-up reputation currently restricts new workers to eval_sweep/benchmark_run. Adding adapter_validation as the next reputation tier gates access to domain_lora_train. Workers prove they can load a base model + adapter before being trusted to train one.

**Flow:**
1. Coordinator uploads adapter to IPFS
2. Creates `adapter_validation` job with adapter CID + eval manifest
3. Worker downloads adapter, loads onto base model, runs quick eval
4. Submits scores
5. Verifier compares against coordinator's own eval of same adapter

---

### Phase 2 — Domain LoRA Training Jobs

**What:** Workers train domain-specific LoRA adapters and upload adapter weights.

**Workload type:** `domain_lora_train`

**Gating:** Workers must have reputation ≥ 5 (passed 5+ eval/validation jobs) to claim training jobs.

**Runtime pinning:** Manifest specifies exact runtime requirements:
```json
{
  "schema_version": 2,
  "workload_type": "domain_lora_train",
  "job_nonce": "server-assigned",
  "domain": "rust",
  "base_model": "Qwen/Qwen2.5-Coder-14B-Instruct",
  "base_model_sha256": "sha256:...",
  "dataset_cid": "QmAbCdEf...",
  "dataset_sha256": "sha256:...",
  "epochs": 2,
  "learning_rate": 2e-4,
  "lora_rank": 32,
  "max_steps": 2000,
  "seed": 42,
  "quantization": "4bit-bnb",
  "min_vram_gb": 16,
  "eval_after_train": true,
  "max_wall_clock_seconds": 7200
}
```

**Verification:** Full hidden quick eval (18-probe), not sampled. Training jobs are higher value and lower count — full verification is justified.

**Adapter output must include:**
- `adapter_model.safetensors`
- `adapter_config.json`
- `training_log.json` (loss curve, lr schedule, wall time)
- Provenance metadata (all hashes, seed, hyperparams)

---

### Phase 3 — Adapter Aggregation

**Merge algorithm:**

**Phase 3 prototype:** Dense-delta + truncated SVD (simple, debuggable).
```python
# Reconstruct dense deltas, weighted average, compress back to rank
deltas = [adapter.B @ adapter.A for adapter in adapters]
merged_delta = weighted_average(deltas, verification_scores)
U, S, Vh = svd(merged_delta)
new_B = U[:, :rank] @ diag(sqrt(S[:rank]))
new_A = diag(sqrt(S[:rank])) @ Vh[:rank, :]
```

**Known limitation:** Truncation back to rank 32 discards residual information every round. Monitor `discarded_residual_norm = ||merged_delta - new_B @ new_A||` to detect when compression is destructive.

**Phase 4 production:** Move to FedEx-LoRA residual-carry scheme (pushes residual into frozen base weights instead of discarding). Reference: arXiv 2410.09432.

**Admission control (do NOT merge every passing adapter):**
- Must pass hidden eval
- Must be non-dominated on at least one target domain
- Must not regress core baseline beyond threshold (3% on any domain)
- Merge set is curated, not mechanical

---

### Phase 4 — Multi-Round Federated Loop

**Do NOT start until:**
- Phase 0-2 have stable artifact handling and verifier telemetry
- 3+ reliable workers with established reputation
- Dataset ≥ 50k pairs
- Merge evaluation harness can detect regressions across rounds

**When ready:**
- Coordinator shards dataset, distributes to workers
- Workers train starting from current best adapter (not base model)
- Coordinator collects, curates, merges, evaluates, publishes if improved
- Re-shard each round (new random split for distribution balance)
- Track residual norm — switch to FedEx-LoRA when SVD truncation exceeds threshold

---

## Revised Economic Model

### The Pricing Reality

HBD ≈ $1 USD (Hive on-chain conversion mechanism). Cloud GPU rates (2026):
- RTX 4090: ~$0.34/hr
- A100: ~$1.19/hr
- H100: ~$1.99/hr

A 30-minute 4090 run costs ~$0.17 at cloud rates. The original plan's 0.05-0.10 HBD for a 30-120 minute training job was **below cost**.

### Revised Job Pricing

| Workload Type | Duration | Budget (HBD) | Notes |
|--------------|----------|-------------|-------|
| `eval_sweep` | 5-30 min | 0.010-0.050 | Low GPU, mostly inference |
| `benchmark_run` | 5-20 min | 0.010-0.050 | Low GPU, mostly inference |
| `data_generation` | 10-30 min | 0.030-0.100 | Medium GPU, inference-heavy |
| `adapter_validation` | 5-15 min | 0.010-0.030 | Load model + quick eval |
| `domain_lora_train` | 30-120 min | 0.200-0.500 | Full training, 16+ GB VRAM |

### Market Positioning

This is **not cloud-competitive pricing**. It is **surplus-idle-GPU participation**:
- Workers donate idle GPU cycles below cloud market rate
- In exchange: earn HBD (real cryptocurrency) for idle compute
- The appeal is passive income from hardware already owned, not competing with RunPod
- Compare to Folding@Home or early Bitcoin mining: under-market compute with non-monetary motivation (community, early participation, reputation)

### Pricing Formula (v1)

```
payout = base_rate_per_minute × expected_minutes × vram_tier_multiplier

where:
  base_rate_per_minute = 0.002 HBD (floor)
  vram_tier_multiplier = {8GB: 0.5, 16GB: 1.0, 24GB: 1.5, 48GB: 2.0}
  expected_minutes = from manifest max_wall_clock_seconds / 60
```

Example: 60-minute training job on 16GB GPU = 0.002 × 60 × 1.0 = **0.120 HBD**

---

## Revised Security Model

### Trust Hierarchy (unchanged)

```
TRUSTED (coordinator): Job creation, verification, merging, payouts
UNTRUSTED (workers): Data gen, training, eval execution — all verified before payout
```

### Expanded Attack Mitigations

| Attack | Mitigation |
|--------|-----------|
| Worker submits fake scores | Full hidden eval re-run by verifier |
| Worker submits garbage adapter | Verifier loads adapter + full hidden eval |
| Worker replays previous good result to new job | `job_nonce` echo + `output_sha256` cross-job dedup |
| Worker submits plagiarized data | Exact + near-dedup against existing corpus |
| Worker submits poisoned training data | Whole-batch structural filters + sampled semantic review + canary probes |
| Hidden eval overfitting over time | Rotate hidden eval set periodically |
| Sybil attack | Warm-up reputation + Hive account age (7-day minimum from v1.0 security hardening) |
| Runtime drift (different quant/tokenizer) | Manifest pins exact model hash, quant backend, tokenizer hash |
| Resource fraud via slow heartbeating | Progress semantics per workload type (e.g., "step 500/2000") |
| Backdoor triggers in training data | Corpus-level anomaly scans + canary probes in merged adapter eval |

### What We Deliberately Do Not Prevent

- Workers seeing training data (open public good)
- Workers copying adapters (public LoRA artifacts)
- Workers using cloud GPUs (compute is compute)

---

## Implementation Order

### Phase 0: Artifact + Provenance (Week 1)
1. `hiveai/compute/models.py` — `ProvenanceMetadata`, `ArtifactRef` dataclasses
2. `hiveai/dbc/compute_client.py` — `upload_artifact()`, `download_artifact()` via IPFS
3. `hiveai/compute/worker.py` — collect + submit provenance on every job
4. HivePoA `compute-service.ts` — `job_nonce` generation, echo validation, SHA-256 dedup
5. Tests + canary

### Phase 1: data_generation (Week 2)
1. `scripts/gen_pairs_worker.py` — pair generator (pinned model allowlist)
2. `hiveai/compute/worker.py` — `_execute_data_generation()`
3. `hiveai/compute/verifier.py` — `DataGenerationVerifier` (layered checks)
4. `hiveai/compute/models.py` — manifest + result dataclasses
5. Tests + canary

### Phase 1.5: adapter_validation (Week 2-3)
1. `hiveai/compute/worker.py` — `_execute_adapter_validation()`
2. `hiveai/compute/verifier.py` — `AdapterValidationVerifier`
3. Reputation gate: workers must pass this to unlock training jobs

### Phase 2: domain_lora_train (Week 3)
1. `scripts/train_domain_worker.py` — wraps train_v5.py, outputs adapter + provenance
2. `hiveai/compute/worker.py` — `_execute_domain_lora_train()`
3. `hiveai/compute/verifier.py` — `DomainLoraTrainVerifier` (full hidden eval, not sampled)
4. Tests + canary with real adapter training

### Phase 3: Aggregation (Week 4)
1. `hiveai/compute/aggregator.py` — dense-delta + SVD with residual norm monitoring
2. `scripts/merge_adapters.py` — CLI with admission control
3. Integration test: 2 training jobs → curated merge → evaluate

### Phase 4: Federated loop (deferred)
- Not until 3+ reliable workers, 50k+ pairs, stable artifact layer

---

## Files That Will Change

### Hive-AI (Python)
| File | Change |
|------|--------|
| `hiveai/compute/models.py` | `ProvenanceMetadata`, `ArtifactRef`, new manifest/result types (schema v2) |
| `hiveai/compute/worker.py` | Provenance collection, 3 new executor methods |
| `hiveai/compute/verifier.py` | 3 new verifiers (data gen, adapter validation, LoRA train) |
| `hiveai/compute/aggregator.py` | **NEW** — dense-delta + SVD merge with admission control |
| `hiveai/dbc/compute_client.py` | IPFS artifact upload/download |
| `scripts/gen_pairs_worker.py` | **NEW** — data generation executor |
| `scripts/train_domain_worker.py` | **NEW** — training executor |
| `scripts/merge_adapters.py` | **NEW** — CLI adapter aggregation |
| `scripts/canary_compute.py` | Canary flows for all new workload types |
| `tests/test_compute.py` | Tests for provenance, new workloads, artifact layer |

### HivePoA (TypeScript)
| File | Change |
|------|--------|
| `server/services/compute-service.ts` | `job_nonce` generation, echo validation, SHA-256 dedup, verification dispatch |
| `server/routes.ts` | `job_nonce` in manifest, payout formula (duration × VRAM tier) |

---

## Success Criteria

**Phase 0 complete when:** Every job result carries provenance, artifacts go to IPFS, replay is prevented.

**Phase 1 complete when:** Worker generates 50 pairs, passes layered verification, earns HBD.

**Phase 1.5 complete when:** Worker loads adapter + runs eval, result verified, reputation gates training access.

**Phase 2 complete when:** Worker trains LoRA adapter, passes full hidden eval, earns HBD.

**Phase 3 complete when:** 2+ adapters merge into a better adapter than any individual, residual norm tracked.

**Phase 4 complete when:** Automated multi-round loop with monotonic improvement, < 2 HBD per round.

---

## Review Questions for GPT (Updated)

1. Is the Phase 0 artifact/provenance contract sufficient, or does it need a formal specification?
2. Is the layered verification for data_generation (structural + corpus + sampled semantic) the right balance?
3. Is the reputation gating (eval → adapter_validation → training) the right progression?
4. Should the pricing formula be dynamic (market-based) or fixed (posted price) for v1?
5. Is FedEx-LoRA the right target for Phase 4, or is there a simpler residual-carry scheme?
6. What corpus-level anomaly scans are practical for detecting training data poisoning?
7. Should the coordinator run verification on every submission or probabilistically audit?
