# HivePoA ↔ Hive-AI Integration Contract

## Status: ACTIVE (both repos reference this document)

**Date:** 2026-03-16
**HivePoA repo:** https://github.com/Dhenz14/HivePoA
**Hive-AI repo:** https://github.com/Dhenz14/Hive-AI

---

## Architecture: Two Apps, One Stack

```
┌─────────────────────────────────────────────────────────┐
│                      Hive-AI                             │
│   Intelligence + Training + Inference + RAG              │
│                                                          │
│   What work gets done. How results are consumed.         │
│                                                          │
│   - Training manifests (what to train, on what data)     │
│   - Eval harnesses (125 challenges, regression_eval.py)  │
│   - Merge logic (dense-delta SVD, FedEx-LoRA)           │
│   - Weakness hunting + critique calibration              │
│   - Confidence scoring + quality gates                   │
│   - Local inference (llama-server + Think + RAG)         │
│                                                          │
│   Deployment: local-first (Flask + GPU + llama-server)   │
└──────────────────────┬──────────────────────────────────┘
                       │
            compute_client.py (REST API)
            The ONLY coupling point.
            Thin, versioned, schema-validated.
                       │
┌──────────────────────┴──────────────────────────────────┐
│                      HivePoA                             │
│   Compute Marketplace + Trust + Governance + Payments    │
│                                                          │
│   Who does the work. How they get paid.                  │
│                                                          │
│   - GPU node registration + discovery                    │
│   - Job scheduling + atomic claiming                     │
│   - Heartbeat + lease management                         │
│   - Shard distribution to workers                        │
│   - Adapter/artifact collection via IPFS                 │
│   - Verification dispatch                                │
│   - Payment settlement (HBD via treasury)                │
│   - Web of Trust + reputation system                     │
│   - Storage tiers + PoA incentivization                  │
│                                                          │
│   Deployment: web service (Express + PostgreSQL + IPFS)  │
└─────────────────────────────────────────────────────────┘
```

## Why They Stay Separate

| Reason | Detail |
|--------|--------|
| **Different release cadences** | HivePoA trust/payment fixes ship independently of Hive-AI training loop changes |
| **Different users** | HivePoA serves any compute participant (could handle non-AI workloads later). Hive-AI serves the coder brain specifically |
| **Different deployment targets** | HivePoA = web service (coordinator). Hive-AI = local-first (GPU trainer + inference) |
| **Clean failure isolation** | HivePoA down → Hive-AI falls back to local-only mode. Hive-AI broken → HivePoA keeps serving other jobs |

Merging would couple a general platform to a specific application. Don't do it.

---

## The Bridge: `compute_client.py`

**Location:** `hiveai/dbc/compute_client.py` (in Hive-AI repo)
**Target:** HivePoA REST API at `/api/compute/*`
**Protocol:** JSON over HTTPS, authenticated via Agent API Key

This is the **only coupling point** between the two repos. All coordination flows through this client.

### What Hive-AI sends to HivePoA

| Operation | Endpoint | Direction |
|-----------|----------|-----------|
| Register GPU node | `POST /api/compute/nodes/register` | Hive-AI → HivePoA |
| Heartbeat | `POST /api/compute/nodes/heartbeat` | Hive-AI → HivePoA |
| Claim next job | `POST /api/compute/jobs/claim-next` | Hive-AI → HivePoA |
| Start job | `POST /api/compute/jobs/:id/start` | Hive-AI → HivePoA |
| Report progress | `POST /api/compute/jobs/:id/progress` | Hive-AI → HivePoA |
| Submit result | `POST /api/compute/jobs/:id/submit` | Hive-AI → HivePoA |
| Fail job | `POST /api/compute/jobs/:id/fail` | Hive-AI → HivePoA |

### What Hive-AI receives from HivePoA

| Data | Source | Usage |
|------|--------|-------|
| Job manifest | Claim response | Tells worker what to compute |
| Lease token | Claim response | Proves ownership of the job attempt |
| Verification result | Settlement callback | Tells coordinator if the work was good |

### What HivePoA never sees

- Training code internals
- Model weights or adapter contents (only CID + SHA-256 reference)
- Eval harness logic (only the score)
- Merge algorithm details
- Weakness hunter prompts or critique memory

HivePoA is a **black-box job executor** from the training perspective. It schedules, verifies (by re-running hidden eval), and pays. It doesn't need to understand what's inside the adapter.

---

## Shared Protocol: JSON Schema Contract

Both repos validate against the same canonical schemas in `HivePoA/schemas/`:

| Schema | HivePoA validates | Hive-AI validates |
|--------|-------------------|-------------------|
| `provenance_v2.json` | On result submission | Before submission |
| `artifact_ref.json` | On result submission | Before submission |
| `manifest_*.json` | On job creation | On job claim (verify before executing) |
| `result_*.json` | On result submission | Before submission |
| `error_codes.json` | On failure reporting | On failure reporting |
| `baseline_registry_entry.json` | On merge publish | On merge decision |

**Fixtures:** Both repos CI-validate the same `schemas/fixtures/*` corpus.
**Versioning:** `schema_version: 2` is current. Additive changes = patch. Breaking changes = bump version.

### Schema Sync Strategy

Hive-AI copies (or git-submodules) the `schemas/` directory from HivePoA. HivePoA is the canonical source. If schemas need to change:

1. Change in HivePoA first
2. Update fixtures
3. Verify HivePoA CI passes
4. Sync to Hive-AI
5. Verify Hive-AI CI passes
6. Only then is the change live

---

## Responsibility Split for GPU Compute Phases

### Phase 0 — Artifact + Provenance

| Component | Repo |
|-----------|------|
| `job_nonce` generation + echo validation | HivePoA |
| SHA-256 dedup (scoped by workload type) | HivePoA |
| Provenance metadata collection | Hive-AI (worker) |
| IPFS artifact upload from worker | Hive-AI (compute_client) |
| IPFS artifact retrieval for verification | HivePoA (verifier) |
| Schema validation on both sides | Both (same fixtures) |

### Phase 1 — Data Generation

| Component | Repo |
|-----------|------|
| Job creation with manifest | HivePoA (coordinator creates job) |
| Job claiming + execution | Hive-AI (worker claims, runs gen_pairs_worker.py) |
| Layered verification (structural + corpus + semantic) | Hive-AI (verifier logic) called by HivePoA (verification dispatch) |
| Payment settlement | HivePoA |

### Phase 1.5 — Adapter Validation

| Component | Repo |
|-----------|------|
| Upload reference adapter to IPFS | Hive-AI (coordinator) |
| Job creation | HivePoA |
| Download adapter + run eval | Hive-AI (worker) |
| Compare scores | Hive-AI (verifier) called by HivePoA |

### Phase 1.75 — Micro-Training Canary

| Component | Repo |
|-----------|------|
| Create 100-step training job | HivePoA (coordinator) |
| Execute training | Hive-AI (worker, wraps train_v5.py) |
| Load adapter + eval | Hive-AI (verifier) |
| Reputation upgrade | HivePoA |

### Phase 2 — Domain LoRA Training

| Component | Repo |
|-----------|------|
| Shard dataset + upload to IPFS | Hive-AI (coordinator logic) |
| Create training jobs | HivePoA (job creation) |
| Download shard + train + upload adapter | Hive-AI (worker) |
| Full hidden eval verification | Hive-AI (verifier) called by HivePoA |
| Payment settlement | HivePoA |
| Shard seed: `hash(block_hash + miner_account)` | Computed by both (independently verifiable) |

### Phase 3 — Adapter Aggregation

| Component | Repo |
|-----------|------|
| Collect verified adapters | HivePoA (artifact retrieval) |
| Dense-delta + SVD merge | Hive-AI (aggregator.py) |
| Admission control (domain-improvement weighted) | Hive-AI |
| Full 60-probe eval of merged adapter | Hive-AI |
| Publish to baseline registry | Both (Hive-AI decides, HivePoA anchors on-chain) |
| Round manifest recording | Both |

### Phase 4 — Multi-Round Federated Loop

| Component | Repo |
|-----------|------|
| Round orchestration | Hive-AI (federated_round.py) |
| Job creation per round | HivePoA |
| FedEx-LoRA / DiLoCo merge | Hive-AI |
| Convergence early-stop (cap at 4 rounds) | Hive-AI |
| Single-miner fallback to improve.py | Hive-AI |
| Recursive weakness_hunter after merge | Hive-AI |
| Synthetic pair submission to DBC | Hive-AI |
| All payment/settlement | HivePoA |

---

## What Each Repo Must NOT Do

### HivePoA must NOT:

- Contain training code, model loading, or adapter merging logic
- Make decisions about what to train or whether a model is good
- Store model weights (only content-addressed references)
- Depend on Hive-AI being available (jobs queue independently)

### Hive-AI must NOT:

- Implement payment settlement, treasury operations, or HBD transfers
- Manage GPU node registration, reputation, or trust directly
- Bypass `compute_client.py` to talk to HivePoA internals
- Assume HivePoA is always available (fall back to local-only mode)

---

## Verification Boundary

This is the most important protocol detail. Verification logic lives in Hive-AI (it knows what a good eval score looks like), but verification is **triggered** by HivePoA (it controls the payout gate).

The flow:

```
1. Worker submits result to HivePoA
2. HivePoA calls verification (which runs Hive-AI's verifier code)
3. Verifier returns: PASS / FAIL / SOFT_FAIL + score + details
4. HivePoA records the decision and settles payment (or doesn't)
```

For v1, the verifier runs on the coordinator machine (which has both HivePoA and Hive-AI installed). In v2+, verification could be distributed to multiple trusted nodes.

The key constraint: **HivePoA never interprets the score**. It only knows pass/fail/soft_fail and a numeric score. The meaning of "0.92 on rust domain" is Hive-AI's business.

---

## Current Connection Points (already built)

| Hive-AI Component | HivePoA Endpoint | Status |
|-------------------|------------------|--------|
| `HivePoAComputeClient.register_node()` | `POST /api/compute/nodes/register` | Working |
| `HivePoAComputeClient.claim_next_job()` | `POST /api/compute/jobs/claim-next` | Working |
| `HivePoAComputeClient.submit_result()` | `POST /api/compute/jobs/:id/submit` | Working |
| `HivePoAComputeClient.heartbeat()` | `POST /api/compute/nodes/heartbeat` | Working |
| `HivePoAComputeClient.create_job()` | `POST /api/compute/jobs` | Working |
| `GPUWorker._execute_eval_sweep()` | Uses regression_eval.py | Working |
| `GPUWorker._execute_benchmark_run()` | Uses executable_eval.py | Working |
| Schema validation (TypeScript) | `schemas/*.json` + Ajv | Working (20 tests) |
| Schema validation (Python) | `schemas/*.json` + jsonschema | **NOT YET — Phase 0 Step 1** |

---

## Next Steps (for Hive-AI team)

1. **Sync schemas:** Copy `HivePoA/schemas/` into Hive-AI (or git submodule)
2. **Add Python conformance tests:** Validate same 12 fixtures with `jsonschema`
3. **Generate Pydantic models from schemas** (schema is source of truth)
4. **Implement provenance collection** in `GPUWorker`
5. **Add IPFS upload/download** to `compute_client.py`
6. **Implement `_execute_data_generation()`** in worker
7. **Implement `DataGenerationVerifier`** with layered checks

All of this is Hive-AI work. HivePoA only needs `job_nonce` generation + echo validation + scoped dedup (Phase 0 Step 4).
