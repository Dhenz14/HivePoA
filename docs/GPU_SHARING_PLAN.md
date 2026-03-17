# GPU Sharing Plan — HivePoA Compute Marketplace

## Status: PLAN v4 (final blueprint — third-party review incorporated)

**Goal:** Anyone with a GPU can contribute compute to the Hive-AI training pipeline and earn HBD. Bittensor-style economics, Hive-native — no separate token, no validator subnet, just HBD via the existing HivePoA treasury/contract system.

**Date:** 2026-03-16 (v4)
**Baseline:** HivePoA `v1.1.0` (sealed at tag `7f4ad10`). Post-release hardening at `a4158a9` (on main, not tagged). Hive-AI compute stack at current main.

> **Clarification:** `v1.1.0` is the sealed tag at `7f4ad10`. `a4158a9` is post-release hardening on main (advisory lock, SQLite parity). Any implementation branch should fork from `a4158a9` on main, not from the `v1.1.0` tag.

### v3 → v4 Changelog

| Change | Source | Rationale |
|--------|--------|-----------|
| Container isolation moved from Phase 4 to Phase 2 prerequisite | GPT review + Claude review | Training workloads run arbitrary code — must isolate before accepting untrusted training jobs |
| Model-parallel removed from phase roadmap | GPT review + Claude review | NCCL over WAN across untrusted nodes is a different class of system. Deferred to vetted-cluster-only track |
| Phase 4 trigger made concrete with operational gates | GPT review | "Queue pressure + Phase 2 stable" was too soft — now has measurable thresholds |
| Aggregator designed as swappable interface | GPT review (FedLoRA survey context) | Research is still moving — need to swap algorithms without protocol changes |
| HTTP artifact ingress path explicitly designed | Claude review | NAT-traversal escape hatch is on the critical path for Phase 0 — was mentioned but unspecified |
| VRAM requirements explicit per workload type | Claude review | Generator model constraint implied but unstated VRAM floor for data_generation |
| Verification compute budget concrete | Claude review | 10% semantic sampling was uncosted — now has concrete model |
| Verifier fee structure stubbed | GPT review | Economics for external compute_verifier role (WoT-vouched) were underspecified |
| Trust model explicitly routed through WoT | Architecture clarification | All validator/verifier governance uses existing trust registry opt-in pattern |
| Rejected: adaptive liveness scheduling | Claude review | Premature complexity. Flat Poisson with per-tier λ is sufficient for v1 |
| Rejected: node vs operator reputation split | Claude review | Hive accounts are the identity layer. WoT handles trust. No new primitives needed |
| Rejected: payout split adjustment | Claude review | 70/30 split is fine for v1 worker attraction. Tightening loses workers |
| Economic model: pay-per-job with compute wallet | Architecture decision | GPU compute is discrete/bursty, not continuous like storage. Tier/subscription model rejected — creates wasted capacity, hostile blocking, unpredictable worker earnings, 6+ billing edge cases. Pay-per-job needs 1 table + 2 endpoints vs 3+ tables + 6+ endpoints + billing cron |
| Rejected: tier/subscription model for GPU | Architecture decision | Storage tiers work because storage is continuous (365-day PoA). GPU is transactional. Every successful GPU marketplace converges on pay-per-use. |

---

## Trust & Governance Model (SETTLED)

All trust and governance routes through the existing **Web of Trust (WoT)** trust registry, implemented in Phase 11 of HivePoA. This is the same model used for storage validators and multisig signers. No new trust primitives.

### Two Participant Types

| Type | Who | Trust Level | Governance |
|------|-----|-------------|------------|
| **Workers** | Anyone with a GPU and a Hive account | Untrusted — all work verified before payout | Self-register via `/api/compute/nodes/register`. Reputation earned through job completion. |
| **Validators** | Hive witnesses (opted in) + WoT-vouched accounts | Trusted — verify worker output, issue challenges | Opt in via HivePoA dashboard. Same pattern as storage validators, multisig signers. |

### Validator Roles (Trust Registry)

GPU compute adds one role to the existing trust registry:

| Role | Vouches Required | Description | Already Exists? |
|------|-----------------|-------------|-----------------|
| `validator` | 1 | PoA storage challenge validators | Yes |
| `treasury_signer` | 3 | Multisig treasury signers | Yes |
| `compute_verifier` | 2 | GPU compute job verifiers + liveness challengers | Yes (schema) |
| `oracle_runner` | 2 | DBC oracle nodes | Yes |
| `dbc_trainer` | 2 | DBC privileged trainers | Yes |

**`compute_verifier`** is the role that matters for this plan. It is already defined in the trust registry schema. Witnesses opt in via the dashboard; they can vouch for non-witness accounts to serve as verifiers too. Same flow as every other role — no special mechanisms.

### Why This Is Sufficient

- **Sybil defense:** Hive accounts have real cost (Resource Credits, 7-day minimum age). Workers must pass warm-up reputation. Validators must be witnesses or WoT-vouched.
- **Accountability:** All Hive accounts have public on-chain history. Verifier actions are logged in `trusted_role_audit_log`.
- **Fail-closed:** If HivePoA is unreachable, trust checks return `eligible=false`.
- **Two distinct concepts, one identity layer:** *Node reputation* measures execution reliability (jobs passed, liveness challenges cleared). *Governance eligibility* (who can verify, who can sign payouts) is gated by WoT roles, not node reputation. A worker with rep 100 cannot verify their own jobs — verification requires the `compute_verifier` role, which is WoT-vouched. This separation already exists in the system; it does not require a new "operator" layer. The Hive account IS the operator identity. One account running 10 GPU nodes is visible and auditable through the public chain.
- **Shard caps limit concentration, not guarantee independence:** Per-account shard caps (Phase 4) reduce blast radius from a single identity. They do not guarantee that multiple Hive accounts are truly independent operators. WoT observation and verifier audit help surface correlated operators, but independence is probabilistic, not guaranteed. This is honest and defensible for a v1 system.

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
- Trust registry: 5 roles including `compute_verifier`, opt-in via dashboard, WoT vouching

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

**IPFS availability policy:**

- **Pinning responsibility:** Worker pins artifact to its local IPFS node and reports CID. Coordinator re-pins to its own node within the verification window. Verification cannot proceed until coordinator has retrieved the artifact.
- **Size-aware retrieval timeouts:**
  - Small artifacts (< 10 MB): 5-minute timeout
  - Medium artifacts (10-100 MB): 10-minute timeout
  - Large artifacts (100-500 MB): 20-minute timeout
- **Retry policy:** Coordinator retries 3x over 15 minutes. If still unavailable, job fails with `artifact_unavailable`.
- **Minimum replication:** Artifact must be retrievable from at least the worker's IPFS node during the verification window. After coordinator re-pins, 2 copies exist (worker + coordinator).
- **Retention:** Pinned for 30 days minimum. GC after 30 days unless referenced by an active adapter in the baseline registry.

> **v1 scope note:** The IPFS availability policy is a verification-window guarantee, not a durability guarantee. This is acceptable for v1 — the coordinator re-pins all verified artifacts.

**3. HTTP artifact ingress (NAT escape hatch — CRITICAL PATH):**

NATed home workers are a real availability risk, not a corner case. DCUtR hole punching adds latency and does not have a 100% success rate. Direct IPFS serving is opt-in, not the baseline assumption.

**Design:**

| Step | Action |
|------|--------|
| **Onboarding probe** | During worker registration, coordinator attempts to fetch a small test file from the worker's IPFS node by CID. If fetch succeeds within 30s, worker is marked `ipfs_direct=true`. If not, `ipfs_direct=false`. |
| **Upload path for NATed workers** | `POST /api/compute/artifacts/upload` — multipart upload to coordinator. Coordinator pins to its own IPFS node, returns CID. Worker includes this CID in result. |
| **Upload path for direct workers** | Worker pins locally, reports CID. Coordinator fetches by CID during verification (normal path). |
| **Size limit** | HTTP upload capped at 500 MB (matches largest artifact: adapter tar.gz). Chunked upload with SHA-256 checksum per chunk. |
| **Auth** | Worker's API key (same as job submission auth). |
| **Rate limit** | 3 uploads/hour per worker account. Prevents abuse of coordinator bandwidth. |
| **Partial-upload cleanup** | Incomplete uploads expire after 10 minutes. Coordinator runs cleanup sweep every 5 minutes to reclaim temp storage. |
| **Budget-aware admission** | Upload only accepted if worker has an active claimed job expecting an artifact. No speculative uploads. |

**Changes needed for HTTP ingress:**

| Repo | File | Change |
|------|------|--------|
| HivePoA | `server/routes.ts` | `POST /api/compute/artifacts/upload` — multipart, streams to IPFS, returns CID |
| HivePoA | `server/services/compute-service.ts` | `uploadArtifact()` method — size validation, SHA-256 verify, pin to coordinator IPFS |
| Hive-AI | `hiveai/dbc/compute_client.py` | `upload_artifact_http(path) → cid` — fallback when `ipfs_direct=false` |

This is the first thing to build and test in Phase 0. If workers can't get artifacts to the coordinator, nothing else works.

**4. Replay prevention:**

- Every manifest includes a `job_nonce` (random, assigned by server at creation)
- Worker must echo `job_nonce` in result provenance
- **Scoped dedup rule:** `output_sha256` dedup is enforced per `(workload_type, artifact_class)`:
  - `data_generation` + `domain_lora_train`: reject cross-job identical artifacts (these should always be unique)
  - `eval_sweep` + `benchmark_run` + `adapter_validation`: allow identical results (deterministic jobs can honestly produce byte-identical outputs)
- The `job_nonce` echo is the primary anti-replay mechanism. Global hash dedup is a secondary defense, not a blanket ban.

**5. Capability matching (explicit VRAM requirements per workload):**

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

**VRAM floors per workload type:**

| Workload | Min VRAM | Rationale |
|----------|----------|-----------|
| `eval_sweep` | 8 GB | Inference-only, quantized model fits in 8 GB |
| `benchmark_run` | 8 GB | Same as eval_sweep |
| `data_generation` | 12 GB | Generator model (qwen3.5:9b ~6 GB quantized) + headroom for batch processing |
| `adapter_validation` | 12 GB | Base model + adapter loaded for inference |
| `domain_lora_train` | 16 GB | Full training with backward pass, QLoRA, optimizer states |

Workers with 8 GB cards are eligible for eval/benchmark only. 12 GB unlocks data generation and validation. 16 GB unlocks training. This is enforced at job claim time via capability matching, not self-reporting — the coordinator uses the VRAM reported during registration (which is verified by liveness challenges in Phase 2).

**Changes needed (Phase 0 core):**

| Repo | File | Change |
|------|------|--------|
| Hive-AI | `hiveai/compute/models.py` | Add `ProvenanceMetadata` dataclass, `ArtifactRef` dataclass |
| Hive-AI | `hiveai/compute/worker.py` | Collect provenance on every job execution, include in result |
| Hive-AI | `hiveai/dbc/compute_client.py` | `upload_artifact(path) → cid` (IPFS direct), `upload_artifact_http(path) → cid` (HTTP fallback), `download_artifact(cid) → path` |
| HivePoA | `server/services/compute-service.ts` | `job_nonce` generation, echo validation, SHA-256 dedup, `uploadArtifact()` |
| HivePoA | `server/routes.ts` | `job_nonce` in manifest on job creation, `POST /api/compute/artifacts/upload` |

**Acceptance tests:**
1. Create eval_sweep job — manifest includes `job_nonce`
2. Worker submits result with provenance metadata + nonce echo
3. Server accepts
4. Same worker resubmits same `output_sha256` to a different job → rejected
5. Worker submits result with wrong `job_nonce` → rejected
6. NATed worker uploads artifact via HTTP ingress → coordinator pins, CID matches
7. Direct worker pins locally → coordinator fetches by CID within timeout

---

### Phase 1 — Data Generation Jobs

**What:** Workers generate training pairs for weak domains. Embarrassingly parallel, no merge complexity.

**Workload type:** `data_generation`

**Generator model constraint:** Manifest specifies a `generator_model_allowlist`. Worker must use a model from the list. This prevents mixed-distribution dataset quality issues. Start with `["qwen3:14b", "qwen3.5:9b"]` — models the coordinator has tested.

**VRAM note:** Workers need 12+ GB to serve a quantized 9B generator model and leave headroom for batch processing. 8 GB cards are excluded from data_generation via capability matching.

**Verification (layered, not just sampling):**

| Check | Layer | Cost |
|-------|-------|------|
| JSONL schema validation | Structural | Cheap — parse every line |
| Required fields present | Structural | Cheap |
| Exact + near-duplicate detection (within batch) | Corpus | Medium — hash + trigram |
| Refusal/template boilerplate detection | Corpus | Cheap — pattern match |
| Repetition + length-distribution anomaly | Corpus | Cheap — stats |
| Domain keyword validator | Corpus | Cheap |
| Sampled quality scoring (10% of pairs via coordinator model) | Semantic | Expensive — LLM call (see budget below) |
| `job_nonce` echo + `output_sha256` dedup | Provenance | Cheap |

**Semantic sampling budget:** 10% of pairs = 5 pairs per 50-pair batch. Scored by coordinator's local model (same generator model used by workers, or a smaller judge model). At ~6 seconds per pair on coordinator GPU, that's ~30 seconds per batch verification. This is acceptable for v1 volumes. If verification becomes a bottleneck at scale, options: reduce sample rate for workers with rep > 20, or offload scoring to a WoT-vouched external verifier (see Verification Economics below).

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
  "max_wall_clock_seconds": 1800,
  "min_vram_gb": 12
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

### Phase 1.75 — Micro-Training Canary

**What:** Before full paid training, workers must pass a capped micro-training canary: 50-100 steps on a known shard. This catches OOMs, disk exhaustion, checkpoint corruption, and Unsloth/QLoRA compatibility issues that only appear under training load, not validation load.

**Flow:**
1. Coordinator creates `domain_lora_train` job with `max_steps: 100` and minimal budget
2. Worker trains 100 steps, submits adapter
3. Verifier loads adapter, runs quick eval
4. If PASS: worker reputation upgraded to "training-capable"
5. If FAIL: worker remains at adapter_validation tier

**Why not skip this:** A worker that can load an adapter and run inference (Phase 1.5) has proved inference compatibility, not sustained training stability. OOMs happen under backward pass, not forward pass.

---

### Phase 2 — Domain LoRA Training Jobs

**What:** Workers train domain-specific LoRA adapters and upload adapter weights.

**Workload type:** `domain_lora_train`

**Gating:** Workers must have reputation ≥ 5 (passed 5+ eval/validation jobs) AND passed a micro-training canary to claim full training jobs.

**Container isolation (PREREQUISITE for Phase 2):**

Training workloads run arbitrary code on worker hardware. Even with reputation gating, workers execute `train_v5.py` with coordinator-supplied hyperparameters using `unsloth`, `transformers`, `torch` — any of which could be patched locally by a malicious worker, or conversely, a malicious training payload could attack the worker. Container isolation protects both sides.

| Requirement | Implementation |
|-------------|----------------|
| Frozen runtime image | Published Docker image with pinned versions: `torch==2.4.0`, `unsloth==2024.12`, `transformers==4.46.0`, `bitsandbytes==0.44.1` |
| GPU passthrough | `--gpus all` flag, NVIDIA Container Toolkit required |
| Network isolation | No outbound network except coordinator API and IPFS gateway |
| Filesystem isolation | Bind-mount: dataset input dir (read-only), output dir (write), no host filesystem access |
| Resource limits | `--memory`, `--shm-size`, disk quota via tmpfs |
| Image verification | Image SHA-256 pinned in manifest. Worker must pull exact image or reject job. |

Workers already running eval_sweep/benchmark_run (Phase 0-1) can continue without containers — those are low-risk inference-only subprocess calls. Container isolation is required starting with training workloads.

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
  "max_wall_clock_seconds": 7200,
  "container_image_sha256": "sha256:..."
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

> **Phase 3 is an experiment, not a trust anchor.** The merge algorithm is intentionally provisional. All publish decisions are subordinate to full eval and rollback capability.

**Aggregator interface (swappable):**

The aggregator is implemented behind a strategy interface so the merge algorithm can be swapped without protocol changes. This is important because federated LoRA research is still moving — recent work (FRLoRA on residual updates, FedMomentum on delta preservation, ILoRA on QR-based rank-heterogeneous fusion, FedSA-LoRA on A/B matrix separation) shows no single universally "better" answer yet. The right choice depends on the regime.

```python
class MergeStrategy(Protocol):
    def merge(self, adapters: list[Adapter], baseline: Adapter, config: MergeConfig) -> MergeResult: ...

class DenseDeltaSVD(MergeStrategy): ...     # Phase 3 default
class FedExLoRA(MergeStrategy): ...          # Phase 4 candidate
class QRFusion(MergeStrategy): ...           # If rank heterogeneity appears
```

**Phase 3 default:** Dense-delta + truncated SVD (simple, debuggable).
```python
# Reconstruct dense deltas, weighted average, compress back to rank
deltas = [adapter.B @ adapter.A for adapter in adapters]

# Weight by normalized improvement over baseline on target domain, NOT raw verifier score
# Raw score overweights adapters good on one hidden slice but broadly mediocre
improvements = [adapter.domain_score - baseline.domain_score for adapter in adapters]
weights = [clip(imp / max(improvements), 0.1, 2.0) for imp in improvements]
weights = normalize(weights)

merged_delta = sum(w * d for w, d in zip(weights, deltas))
U, S, Vh = svd(merged_delta)
new_B = U[:, :rank] @ diag(sqrt(S[:rank]))
new_A = diag(sqrt(S[:rank])) @ Vh[:rank, :]
```

**Known limitation:** Truncation back to rank 32 discards residual information every round. Monitor `discarded_residual_norm = ||merged_delta - new_B @ new_A||` to detect when compression is destructive.

**Upgrade path:** Switch to FedEx-LoRA residual-carry (pushes residual into frozen base weights instead of discarding) when residual norm exceeds threshold. Reference: arXiv 2410.09432. If client ranks vary, design for QR-based aggregation (ILoRA). If shard distributions are strongly non-IID, server-side optimizer-state handling may matter more than merge algorithm choice.

**Admission control (do NOT merge every passing adapter):**

- Must pass hidden eval
- Must be non-dominated on at least one target domain
- Must not regress core baseline beyond threshold (3% on any domain)
- Merge set is curated, not mechanical

**Merge weighting:** Weight by **normalized improvement over baseline on the target domain**, clipped to [0.1, 2.0]. Do NOT use raw verifier score — it overweights adapters that are good on one hidden slice but broadly mediocre.

**Diversity bonus:** `target_domain_improvement × (1 + capped_diversity_bonus)` where diversity = distance to already-selected adapters. Diversity is a multiplier/tiebreaker, not the primary signal. Marginal-gain check after tentative merge: does adding this adapter actually improve the merged result? If not, exclude it even if it passes admission.

**Baseline registry (immutable):**

Every merged adapter version is recorded with:
```json
{
  "version": "v6",
  "parent_version": "v5",
  "merged_at": "2026-04-01T12:00:00Z",
  "contributing_job_ids": ["job-1", "job-2", "job-3"],
  "contributing_workers": ["worker-a", "worker-b"],
  "dataset_cids": ["QmAbc...", "QmDef..."],
  "merge_algorithm": "dense_delta_svd",
  "merge_rank": 32,
  "discarded_residual_norm": 0.023,
  "eval_scores": {"python": 0.94, "rust": 0.96, "go": 0.93},
  "overall_score": 0.945,
  "baseline_improvement": 0.012,
  "adapter_cid": "QmMerged...",
  "adapter_sha256": "sha256:..."
}
```

This enables regression forensics: when a merged round regresses, you can trace exactly which datasets, workers, and verifier versions contributed.

**Round manifest:** Each aggregation round produces a round manifest that lists all inputs, all admission decisions (accepted/rejected + reason), merge weights, and output adapter reference. This is the audit trail for the merge.

**Registry storage (hybrid):** Keep the authoritative baseline registry off-chain in the coordinator DB for speed and queryability. Periodically anchor immutable snapshots to Hive via `custom_json` containing the registry root hash. This gives cheap operations plus an auditable timestamped anchor without forcing the full registry on-chain.

---

### Phase 4 — Multi-Round Federated Loop

**Concrete trigger gates (ALL must be met):**

| Gate | Threshold | Rationale |
|------|-----------|-----------|
| Queue backlog | Sustained > 10 queued training jobs for 48+ hours | Proves real demand, not synthetic load |
| Verifier false-accept rate | < 5% on hidden eval audits over trailing 30 days | Verification must be reliable before scaling |
| Stable worker pool | 3+ workers from 2+ distinct Hive accounts with rep ≥ 50 | Prevents single-operator federated training |
| Dataset size | ≥ 50k verified pairs across 3+ domains | Enough data to shard meaningfully |
| Merge evaluation harness | Can detect 2% regression across domains within 1 round | Must catch regressions before compounding |

Do NOT start until all five gates are met. "Queue pressure + Phase 2 stable" is not sufficient.

**Per-account shard caps:** No single Hive account may hold more than 40% of shards in a federated round. Enforced at the job scheduler level using the Hive account from worker registration.

**Honesty note:** Shard caps limit concentration per *identity*, not guarantee *independence*. If one real-world operator controls multiple Hive accounts, per-account caps do not buy true diversity. WoT observation, verifier audit patterns, and correlated-failure analysis help surface suspicious operator clustering, but independence is probabilistic, not guaranteed. This is acceptable for v1 — the claim is "blast-radius reduction per identity," not "fully decentralized federation."

**When ready:**
- Coordinator shards dataset, distributes to workers (respecting per-account caps)
- Workers train starting from current best adapter (not base model)
- Coordinator collects, curates, merges (via swappable aggregator), evaluates, publishes if improved
- Re-shard each round (new random split for distribution balance)
- Track residual norm — switch merge strategy when SVD truncation exceeds threshold

### Model-Parallel (DEFERRED — Vetted Cluster Only)

Model-parallel training across untrusted marketplace nodes is a fundamentally different problem from federated LoRA. NCCL is built for tightly synchronized inter-GPU communication, is topology-aware, and assumes conventional multi-node GPU environments — not adversarial home nodes across a WAN.

**Status:** Not on the phase roadmap. If needed, limited to vetted clusters under one operator or a tightly controlled LAN. Will not enter general marketplace until hard data proves transport and failure semantics are manageable.

---

## Verification Economics

### Current Model (v1 — Coordinator Self-Verifies)

The coordinator runs verification itself. This works because:
- Volume is low (< 100 jobs/day expected in v1)
- Coordinator has its own GPU for re-running evals
- Trust is simple: coordinator is the authority

### Stubbed Model (v2 — External Verifier Pool)

When volume exceeds coordinator capacity, WoT-vouched `compute_verifier` accounts can serve as external verifiers. The fee structure is designed now so it can slot in without protocol changes:

| Component | Source | Amount |
|-----------|--------|--------|
| **Verifier fee** | Carved from job budget at creation | 10% of posted price |
| **Verifier bond** | Staked by verifier account | 10× the fee for that workload class |
| **Audit lottery** | Random re-verification by coordinator | 5% of verified jobs are re-checked |

**Fee flow:**
1. Job created with `budget = posted_price`. Verifier fee (10%) is reserved.
2. `compute_verifier` (WoT-vouched) claims verification task.
3. Verifier runs hidden eval, submits verdict.
4. If verdict matches coordinator audit (when audited): verifier paid, reputation +1.
5. If verdict contradicts coordinator audit: verifier fee withheld, bond slashed, reputation -5.

**Edge cases (designed but not implemented until v2):**
- **No verifier claims:** Job stays in `verifying` state. After 1-hour timeout, coordinator self-verifies as fallback. External verifiers are a throughput optimization, not a hard dependency.
- **Verification is mandatory vs sampled:** See Verification Throughput Policy — high-value workloads (training, data gen) are always verified. Low-value workloads (eval, benchmark) use probabilistic audit for proven workers. This policy is the same regardless of whether the coordinator or an external verifier runs the check.
- **Who pays for verification compute:** In v1, the coordinator absorbs it. In v2, the fee is carved from the job budget before worker payout. Workers see slightly lower net payouts but get faster verification turnaround.

**v1 implementation (CONSCIOUS DEFERRAL):** Coordinator self-verifies. Verifier fee is not carved out — full budget goes to worker. This is intentional: the external verifier pool is a scaling mechanism, not a v1 requirement. The carved-fee-from-budget mechanism, external verifier assignment, bond/slash, and audit lottery are implemented in v2 when volume demands it. The job manifest schema already has room for `verifier_account` and `verifier_fee_hbd` fields, so the protocol doesn't need to change.

---

## Economic Model (SETTLED — Pay-Per-Job)

### Design Decision: Pay-Per-Job, Not Subscriptions

GPU compute is a **discrete, bursty service** — fundamentally different from storage. Storage tiers work because files need continuous PoA challenges over 365 days (steady-state service). GPU jobs are fire-and-forget: submit, run 30 minutes, get result, maybe nothing for a week.

A subscription/tier model creates: wasted capacity (use-it-or-lose-it), hostile blocking mid-pipeline, unpredictable per-job worker earnings, and 6+ edge cases around billing periods, in-flight jobs at month boundaries, partial refunds, and parallel job hour-draining race conditions.

Pay-per-job requires: one new table (compute wallet), two new endpoints (deposit, balance check). Everything else is already built and soak-tested.

**This is a binding design decision. No tier/subscription model for GPU compute.**

### Compute Wallet

Every Hive account has a compute wallet balance. Jobs deduct from it atomically at creation.

**How it works:**
1. User deposits HBD into compute wallet (`POST /api/compute/wallet/deposit`)
2. User creates a job → server checks balance ≥ posted price for that workload type
3. Balance deducted atomically at job creation (same pattern as storage contract budget hold)
4. Job completes → 3-stage payout to worker from the held amount
5. Job fails → held amount returned to wallet (minus any cancellation payout owed)
6. Balance hits zero → new jobs rejected with 402 (insufficient balance). Existing in-flight jobs unaffected.

**Wallet schema (one new table):**
```sql
CREATE TABLE compute_wallets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  balance_hbd   DECIMAL(10,3) NOT NULL DEFAULT 0,
  total_deposited_hbd  DECIMAL(10,3) NOT NULL DEFAULT 0,
  total_spent_hbd      DECIMAL(10,3) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
```

**Balance operations are atomic:** Deduct uses `UPDATE compute_wallets SET balance_hbd = balance_hbd - $1 WHERE username = $2 AND balance_hbd >= $1 RETURNING balance_hbd`. If the row isn't updated (insufficient balance), job creation fails. No race conditions. Same pattern as `pg_advisory_xact_lock` we use for storage quota.

**New endpoints (two):**

| Endpoint | Method | Auth | Action |
|----------|--------|------|--------|
| `/api/compute/wallet/deposit` | POST | Bearer | Add HBD to wallet balance. Verified via Hive transfer memo or direct treasury deposit. |
| `/api/compute/wallet/balance` | GET | Bearer | Return current balance, total deposited, total spent. |

Existing endpoint `POST /api/compute/jobs` gains a balance check: reject with 402 if wallet balance < posted price for the requested workload type.

### Posted Rates (Fixed Per-Job Pricing)

| Workload Type | Posted Price | Min VRAM | Duration | Notes |
|--------------|-------------|----------|----------|-------|
| `eval_sweep` | **0.020 HBD** | 8 GB | 5-30 min | Low GPU, inference-only |
| `benchmark_run` | **0.020 HBD** | 8 GB | 5-20 min | Low GPU, inference-only |
| `data_generation` | **0.050 HBD** | 12 GB | 10-30 min | Per 50-pair batch, inference-heavy |
| `adapter_validation` | **0.020 HBD** | 12 GB | 5-15 min | Load model + quick eval |
| `domain_lora_train` | **0.300 HBD** | 16 GB | 30-120 min | Full training, containerized |

Fixed posted prices. No dynamic pricing. No formula. If the market proves too thin, raise prices manually — do not add complexity until there are 10+ active workers.

### Market Positioning

This is **not cloud-competitive pricing**. It is **surplus-idle-GPU participation**:

HBD ≈ $1 USD (Hive on-chain conversion mechanism). Cloud GPU rates (2026): RTX 4090 ~$0.34/hr, A100 ~$1.19/hr, H100 ~$1.99/hr. A 30-minute 4090 training run costs ~$0.17 at cloud rates. Our posted price: 0.300 HBD for a full training job.

- Workers contribute idle GPU cycles below cloud market rate
- In exchange: earn HBD (real cryptocurrency, $1-pegged stablecoin) for idle compute
- The appeal is passive income from hardware already owned, not competing with RunPod
- Compare to Folding@Home or early Bitcoin mining: under-market compute with non-monetary motivation (community, early participation, reputation)
- **HBD stablecoin advantage over competitors:** Bittensor pays in TAO (volatile), Nosana in NOS (volatile), Akash in AKT (volatile). HBD is pegged — workers know exactly what they earn.

### Payout Structure (Proven — 10 Real-Money Soak Cycles, Zero Failures)

```text
Job acceptance triggers 3 frozen payout rows:
  Validity fee:   30% of budget  (correct hardware + structural checks passed)
  Completion fee: 40% of budget  (job completed, artifacts uploaded, provenance valid)
  Bonus:          30% × score    (quality-weighted by verifier hidden eval)

Cancellation (partial work):
  min(0.8, elapsed/lease) × 30% of budget

Failed job (worker fault):
  Held amount returned to requester's compute wallet
```

"Completion" is not just showing up. It means: the worker executed the workload, uploaded artifacts to IPFS (or via HTTP ingress), passed provenance checks, and the coordinator retrieved the output. The 30% quality bonus is scored by hidden eval.

This 70/30 split is intentional for v1 worker attraction. If quality gaming becomes a problem at scale, shift more weight to the bonus — but do not tighten prematurely and lose workers.

### Worker Economics (What GPU Lenders Earn)

| Workload | Payout on Perfect Score | Time Investment | Effective Rate |
|----------|------------------------|-----------------|----------------|
| `eval_sweep` | 0.020 HBD | ~15 min | ~$0.08/hr |
| `benchmark_run` | 0.020 HBD | ~10 min | ~$0.12/hr |
| `data_generation` | 0.050 HBD | ~20 min | ~$0.15/hr |
| `adapter_validation` | 0.020 HBD | ~10 min | ~$0.12/hr |
| `domain_lora_train` | 0.300 HBD | ~60 min | ~$0.30/hr |

These are below cloud market rate by design. The value proposition is idle-GPU passive income, not full-time employment. A worker running a 4090 overnight on training jobs earns ~2.4 HBD/8hrs — real money for hardware doing nothing otherwise.

### Why Not Tiers/Subscriptions (Design Rationale)

Storage tiers work because storage is a **continuous service**: files sit there 24/7 needing PoA challenges every ~3 days. The math is clean: `tier_budget / estimated_challenges = reward_per_proof`.

GPU compute is **transactional**: submit job → run → done. Forcing GPU into a subscription model creates:
- **Wasted capacity:** User buys 5 GPU-hours/month, uses 2 → 3 wasted
- **Hostile blocking:** User hits cap mid-pipeline on job 4 of 5 → stuck
- **Unpredictable worker earnings:** `tier_budget / jobs_this_month` — denominator unknown until month ends
- **6+ edge cases:** In-flight jobs at month boundary, parallel job hour-draining, partial refunds, billing cron, overage handling, pro-rated cancellation
- **3+ extra tables, 6+ extra endpoints, a billing cron job** vs. 1 table and 2 endpoints for pay-per-job

Pay-per-job: one table, two endpoints, zero edge cases beyond what's already tested. Every successful GPU marketplace (RunPod, Vast.ai, Lambda, Salad) converges on pay-per-use for this reason.

### Optional Future: Bulk Credit Discounts

If marketing wants a "pick a plan" UX without subscription mechanics:

| Pack | Credit | Price | Discount |
|------|--------|-------|----------|
| Starter | 1.000 HBD credit | 1.000 HBD | 0% (base rate) |
| Builder | 5.000 HBD credit | 4.500 HBD | 10% off |
| Studio | 15.000 HBD credit | 12.000 HBD | 20% off |

Buy in bulk → deposited to compute wallet → spend at posted rates. No expiration, no use-it-or-lose-it. This is deferred — not needed for v1.

---

## Revised Security Model

### Trust Hierarchy

```
TRUSTED (coordinator):     Job creation, verification, merging, payouts
TRUSTED (compute_verifier): GPU job verification, liveness challenges (WoT-vouched via trust registry)
UNTRUSTED (workers):        Data gen, training, eval execution — all verified before payout
```

All trusted roles route through the Web of Trust trust registry. Witnesses opt in via HivePoA dashboard. Non-witness accounts are vouched by witnesses. Same pattern as storage validators and multisig signers. No new trust mechanisms.

### Expanded Attack Mitigations

| Attack | Mitigation |
|--------|-----------|
| Worker submits fake scores | Full hidden eval re-run by verifier |
| Worker submits garbage adapter | Verifier loads adapter + full hidden eval |
| Worker replays previous good result to new job | `job_nonce` echo + `output_sha256` cross-job dedup |
| Worker submits plagiarized data | Exact + near-dedup against existing corpus |
| Worker submits poisoned training data | Whole-batch structural filters + sampled semantic review + canary probes |
| Hidden eval overfitting over time | Rotate hidden eval set periodically |
| Sybil attack | Warm-up reputation + Hive account age (7-day minimum) + per-account shard caps in Phase 4 |
| Runtime drift (different quant/tokenizer) | Manifest pins exact model hash, quant backend, tokenizer hash |
| Resource fraud via slow heartbeating | Progress semantics per workload type (e.g., "step 500/2000") |
| Backdoor triggers in training data | Corpus-level anomaly scans + canary probes in merged adapter eval |
| Malicious worker patches local deps | Container isolation with pinned image SHA-256 (Phase 2+) |
| One account dominates federated round | Per-account shard cap (40%) enforced at scheduler level |

### Verification Throughput Policy

The verifier is an intentional bottleneck. This is acceptable in v1.

| Workload | Verification | Rationale |
|----------|-------------|-----------|
| `domain_lora_train` | **Every submission** — full hidden eval | High value, low volume, must catch bad adapters before merge |
| `adapter_validation` | **Every submission** — full hidden eval | Gate for training access, must be reliable |
| `data_generation` | **Every submission** — layered structural + corpus + 10% semantic sampling (5 pairs/batch, ~30s coordinator GPU time) | Medium value, need whole-batch filters |
| `eval_sweep` | **Every submission for reputation < 10**, probabilistic audit (30%) after | Low value, high volume at scale |
| `benchmark_run` | Same as eval_sweep | Same economics |

Probabilistic audit is acceptable ONLY for low-value workloads AFTER workers have proven reputation. Never for training or data generation — those produce artifacts that enter the training pipeline.

### Liveness Challenges (Phase 2)

Flat Poisson-distributed challenge frequency: ~1/hour/miner, tunable per reputation tier. No adaptive scheduling in v1 — the variance comes from the Poisson distribution itself, which is sufficient to prevent timing prediction.

Per-tier λ values (configurable):
- Warm-up (rep 0-19): λ = 2/hour (more frequent, building trust)
- Standard (rep 20-49): λ = 1/hour
- Trusted (rep 50+): λ = 0.5/hour (proven nodes, less overhead)

Challenge content is server-generated with nonce. The nonce must drive a large challenge family — a small prompt catalog with a huge seed is still a small challenge space. Ensure the nonce expands into materially different tensors/prompts/shards so caching is not viable.

### What We Deliberately Do Not Prevent

- Workers seeing training data (open public good)
- Workers copying adapters (public LoRA artifacts)
- Workers using cloud GPUs (compute is compute)

---

## Implementation Order

### Phase 0: Artifact + Provenance (Week 1)
1. **HTTP artifact ingress endpoint** — `POST /api/compute/artifacts/upload` (critical path for NATed workers)
2. `hiveai/compute/models.py` — `ProvenanceMetadata`, `ArtifactRef` dataclasses
3. `hiveai/dbc/compute_client.py` — `upload_artifact()` (IPFS direct), `upload_artifact_http()` (HTTP fallback), `download_artifact()`
4. `hiveai/compute/worker.py` — collect + submit provenance on every job, IPFS vs HTTP upload auto-selection
5. HivePoA `compute-service.ts` — `job_nonce` generation, echo validation, SHA-256 dedup, `uploadArtifact()`
6. Tests + canary (including NATed-worker HTTP upload path)

### Phase 1: data_generation (Week 2)
1. `scripts/gen_pairs_worker.py` — pair generator (pinned model allowlist)
2. `hiveai/compute/worker.py` — `_execute_data_generation()`
3. `hiveai/compute/verifier.py` — `DataGenerationVerifier` (layered checks + 10% semantic sampling)
4. `hiveai/compute/models.py` — manifest + result dataclasses
5. Tests + canary

### Phase 1.5: adapter_validation (Week 2-3)

1. `hiveai/compute/worker.py` — `_execute_adapter_validation()`
2. `hiveai/compute/verifier.py` — `AdapterValidationVerifier`
3. Reputation gate: workers must pass this to unlock micro-training canary

### Phase 1.75: micro-training canary (Week 3)

1. Coordinator creates 100-step training job on known shard
2. Worker trains, submits adapter
3. Verifier loads + evals — catches OOM, disk, checkpoint issues
4. PASS → worker reputation upgraded to "training-capable"

### Phase 2: domain_lora_train (Week 3-4)

1. **Publish frozen Docker training image** with pinned deps (torch, unsloth, transformers, bitsandbytes)
2. `scripts/train_domain_worker.py` — wraps train_v5.py, runs inside container, outputs adapter + provenance
3. `hiveai/compute/worker.py` — `_execute_domain_lora_train()` (launches container with GPU passthrough)
4. `hiveai/compute/verifier.py` — `DomainLoraTrainVerifier` (full hidden eval, not sampled)
5. Tests + canary with real adapter training in container

### Phase 3: Aggregation (Week 4-5)

1. `hiveai/compute/aggregator.py` — `MergeStrategy` interface + `DenseDeltaSVD` default implementation with residual norm monitoring
2. `scripts/merge_adapters.py` — CLI with admission control (domain-improvement weighted + diversity bonus)
3. Baseline registry + round manifest for regression forensics
4. Integration test: 2 training jobs → curated merge → evaluate

### Phase 4: Federated loop (deferred until all 5 trigger gates met)
- See concrete trigger gates above
- Per-account shard caps enforced at scheduler level

---

## Files That Will Change

### Hive-AI (Python)
| File | Change |
|------|--------|
| `hiveai/compute/models.py` | `ProvenanceMetadata`, `ArtifactRef`, new manifest/result types (schema v2) |
| `hiveai/compute/worker.py` | Provenance collection, 3 new executor methods, IPFS/HTTP upload auto-selection, container launch for training |
| `hiveai/compute/verifier.py` | 3 new verifiers (data gen, adapter validation, LoRA train) |
| `hiveai/compute/aggregator.py` | **NEW** — `MergeStrategy` interface + `DenseDeltaSVD` + admission control |
| `hiveai/dbc/compute_client.py` | IPFS artifact upload/download + HTTP ingress fallback |
| `scripts/gen_pairs_worker.py` | **NEW** — data generation executor |
| `scripts/train_domain_worker.py` | **NEW** — training executor (containerized) |
| `scripts/merge_adapters.py` | **NEW** — CLI adapter aggregation |
| `scripts/canary_compute.py` | Canary flows for all new workload types |
| `tests/test_compute.py` | Tests for provenance, new workloads, artifact layer, HTTP ingress |
| `Dockerfile.training` | **NEW** — frozen training image with pinned deps |

### HivePoA (TypeScript)
| File | Change |
|------|--------|
| `server/services/compute-service.ts` | `job_nonce` generation, echo validation, SHA-256 dedup, `uploadArtifact()`, verification dispatch |
| `server/routes.ts` | `job_nonce` in manifest, `POST /api/compute/artifacts/upload`, posted-price payout lookup by workload type |

---

## Success Criteria

**Phase 0 complete when:** Every job result carries provenance, artifacts go to IPFS (or via HTTP ingress for NATed workers), replay is prevented, and both upload paths are tested end-to-end.

**Phase 1 complete when:** Worker generates 50 pairs, passes layered verification including semantic sampling, earns HBD.

**Phase 1.5 complete when:** Worker loads adapter + runs eval, result verified, reputation gates training access.

**Phase 2 complete when:** Worker trains LoRA adapter in frozen Docker container, passes full hidden eval, earns HBD.

**Phase 3 complete when:** 2+ adapters merge via swappable aggregator into a better adapter than any individual, residual norm tracked, round manifest produced.

**Phase 4 complete when:** All 5 trigger gates met. Automated multi-round loop with monotonic improvement, per-account shard caps enforced. Cost target: < 2 HBD per prototype round (defined as 3-5 training jobs + verification overhead, NOT a universal ceiling).

---

## Design Decisions (Resolved)

All seven review questions from v3 have been answered through three rounds of systems review (Claude + GPT). These are now **binding design decisions**, not open questions.

### D1. Schema source of truth: Canonical JSON Schema (schema-first)

One canonical `schemas/` directory with JSON Schema 2020-12 files. Both repos consume it:
- **TypeScript:** validate with Ajv in strict mode
- **Python:** generate Pydantic models from schema via `datamodel-code-generator`
- **CI:** validate sample manifests/results against schema on both sides

The protocol itself is the source of truth — not Python dataclasses, not TypeScript interfaces. This is the single most important prerequisite before Phase 0 implementation starts.

Schema files needed:
- `schemas/provenance_v2.json` — provenance metadata contract
- `schemas/manifest_eval_sweep.json` — eval sweep manifest
- `schemas/manifest_data_generation.json` — data generation manifest
- `schemas/manifest_domain_lora_train.json` — training manifest
- `schemas/result_eval_sweep.json` — eval sweep result
- `schemas/result_data_generation.json` — data generation result
- `schemas/result_domain_lora_train.json` — training result
- `schemas/baseline_registry_entry.json` — baseline registry record

### D2. Reputation ladder: Keep all four steps

`eval_sweep` → `adapter_validation` → `micro-training canary` → `full training`

Do NOT collapse. They test different failure modes:
- `adapter_validation` proves inference-path compatibility (forward pass)
- `micro-training canary` proves backward-pass stability (OOM, checkpoint, disk)

If worker supply becomes the bottleneck later, collapse then. Right now the extra gate is justified — paying for unstable workers and poisoning the job queue with training failures is the bigger early risk.

### D3. Merge algorithm staging: Swappable interface, dense-delta + SVD default

- **Phase 3:** `MergeStrategy` interface with `DenseDeltaSVD` default. Residual norm monitoring and rollback.
- **Phase 4:** Swap to FedEx-LoRA, QR fusion, or FedSA-style A/B separation based on observed regime (rank heterogeneity, non-IID drift, optimizer-state mismatch).

The aggregator is a swappable interface by design. The research landscape (FRLoRA, FedMomentum, ILoRA, FedGaLore, FedSA-LoRA) shows no single winner. Branch by workload regime, not by theory preference.

### D4. Poisoning defense: Behavioral canaries over trigger regexes

Practical scan stack (in priority order):
1. Exact dedup + near-dedup
2. Refusal/template boilerplate detection
3. Abnormal length/repetition distribution
4. Domain-keyword or domain-classifier checks
5. **Canary prompts embedded in held-out eval** (primary defense against subtle poisoning)
6. Embedding-centroid drift by domain over time
7. N-gram trigger scans (cheap filter, NOT primary defense)

Trigger regexes will not catch most poisoning — subtle attacks look statistically normal locally and only show as behavior drift on targeted probes. Canary probes are the real defense.

### D5. IPFS availability: Size-aware timeouts, NAT workers default to HTTP ingress

- Size-aware timeouts (5/10/20 min by artifact size)
- NATed workers default to `POST /api/compute/artifacts/upload` (HTTP ingress to coordinator IPFS)
- Direct IPFS serving is opt-in after passing onboarding fetch test
- "2 copies after re-pin" is verification-window safety, NOT durability

### D6. Baseline registry: Hybrid (off-chain primary + on-chain anchoring)

- **Off-chain coordinator DB:** Authoritative working registry. Fast queries, hot operational path.
- **Periodic Hive `custom_json` anchors:** Tamper-evident checkpoints of registry/round-manifest root hashes.

### D7. Merge weighting: Domain improvement + capped diversity bonus

Two-stage rule:
1. **Admission floor:** No major regressions, hidden eval pass, non-dominated on at least one domain
2. **Merge weight:** `target_domain_improvement × (1 + capped_diversity_bonus)`

Diversity bonus = distance to already-selected adapters, capped so outliers do not dominate. Marginal-gain check after tentative merge: does adding this adapter actually improve the merged result? If not, exclude.

### D8. Trust model: Web of Trust (SETTLED)

All validator/verifier governance routes through the existing HivePoA trust registry. GPU compute adds no new trust primitives. `compute_verifier` role follows the same opt-in/vouch pattern as `validator`, `treasury_signer`, and all other roles. Hive accounts are the identity layer. No separate operator reputation system.

### D9. Container isolation: Phase 2 prerequisite — training workloads only

**Scope (explicit):**
- **Requires container:** `domain_lora_train` (runs backward pass with arbitrary hyperparameters, writes adapter weights — highest attack surface)
- **Does NOT require container:** `eval_sweep`, `benchmark_run`, `adapter_validation`, `data_generation` (inference-only subprocess calls with coordinator-supplied prompts/models — lower risk, and requiring containers here would increase worker friction and reduce test-surface simplicity during early phases)

Frozen Docker image with pinned deps, GPU passthrough, network isolation, filesystem isolation. If data_generation or adapter_validation workloads are later opened to untrusted manifest requesters (not just coordinator-curated), container isolation must be extended to those workloads at that time.

### D10. Liveness scheduling: Flat Poisson, per-tier λ (v1 default, not frozen)

v1 default: Flat Poisson distribution with configurable λ per reputation tier (warm-up: 2/hr, standard: 1/hr, trusted: 0.5/hr). No adaptive uncertainty-driven scheduling in v1.

This is an **ops-configurable parameter**, not an immutable system invariant. The λ values are stored in coordinator config and can be patched without protocol changes. "Flat" means no reputation-tier favoritism beyond the three tiers above in v1 — it does not mean "immutable forever." If evidence of gaming emerges, or if the worker pool grows beyond 50 nodes, adaptive scheduling can be introduced as a config change, not a protocol change.

---

## Implementation Gate

The plan is now a **closed protocol specification** pending one action:

> **Publish the canonical JSON Schema files in `schemas/` and add CI validation on both repos.**

After that, Phase 0 implementation can begin. No further design review needed for Phases 0-2.

---

## Review Questions for GPT (v4)

Previous reviews (v2, v3) addressed: schema source of truth, pricing model, verification policy, reputation ladder, merge algorithm, IPFS availability, registry storage, merge weighting. All resolved as binding decisions.

v4 incorporates GPT's feedback on: container isolation timing, model-parallel deferral, concrete Phase 4 gates, verifier economics, aggregator interface design.

Remaining questions (focused, not architectural):

1. **Is the HTTP artifact ingress design (POST to coordinator, coordinator pins to IPFS) the right NAT escape hatch?** Or should NATed workers use a relay/proxy IPFS node instead? The HTTP path is simpler to implement and audit, but creates coordinator bandwidth dependency.

2. **Is 10% semantic sampling (5 pairs per 50-pair batch, ~30s coordinator GPU) the right verification budget for data_generation?** What's the minimum sample rate that catches quality gaming without making verification a bottleneck?

3. **Is the per-account 40% shard cap for Phase 4 federated rounds the right number?** With 3 workers minimum, 40% means one account can hold at most ~40% of shards. With 10 workers, it's still 40%. Should the cap decrease as pool size grows?

4. **For the frozen Docker training image: should the worker pull from a public registry (Docker Hub) or from the coordinator's own registry?** Public is simpler but creates a supply-chain trust dependency on Docker Hub. Coordinator-hosted is more controlled but adds infrastructure.

5. **Is the verifier bond (10× fee) the right ratio for the v2 external verifier pool?** Too low and rubber-stamping is profitable. Too high and nobody stakes. What's the equilibrium for a thin market?
