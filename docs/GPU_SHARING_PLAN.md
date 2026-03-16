# GPU Sharing Plan — HivePoA Compute Marketplace

## Status: PLAN (for review by all collaborators)

**Goal:** Anyone with a GPU can contribute compute to the Hive-AI training pipeline and earn HBD. Bittensor-style economics, but Hive-native — no separate token, no validator subnet, just HBD via the existing HivePoA treasury/contract system.

**Date:** 2026-03-16
**Baseline:** HivePoA `v1.1.0` (tag `a4158a9`), Hive-AI compute stack at current main

---

## What Already Exists (DO NOT REBUILD)

### HivePoA Server (TypeScript/Express)
- **20+ compute endpoints** live at `/api/compute/*`
- **Atomic job claiming** via `SELECT ... FOR UPDATE SKIP LOCKED`
- **Lease sweeper** — cleans stale leases every 60s
- **Node registration** with GPU model, VRAM, supported workloads, cached models
- **Job lifecycle** — create → claim → start → progress → submit → verify → settle
- **Three-stage payouts** — budget held, verification, then settlement
- **Warm-up reputation** — new nodes start with restricted workloads (eval_sweep, benchmark_run only)
- **6 workload types defined:** `eval_sweep`, `benchmark_run`, `adapter_validation`, `domain_lora_train`, `weakness_targeted_generation`, `data_generation`
- **Only 2 workload types implemented in the worker:** `eval_sweep`, `benchmark_run`

### Hive-AI Worker (Python)
- **`GPUWorker` class** (413 lines) — registers, polls, claims, executes, heartbeats, submits results
- **`EvalSweepVerifier` + `BenchmarkRunVerifier`** — server-side re-verification with 15% deviation tolerance
- **`HivePoAComputeClient`** — full REST client for all compute endpoints
- **`scripts/gpu_worker.py`** — CLI entry point with all config flags
- **`scripts/canary_compute.py`** — end-to-end canary with mock mode
- **17 tests** covering contracts, worker, verifier, client

### Training/Eval Scripts (Available but NOT wired to worker)
- `scripts/regression_eval.py` — 60-probe domain eval (ALREADY wired)
- `scripts/executable_eval.py` — code gen + sandbox (ALREADY wired)
- `scripts/train_v5.py` — Unsloth + QLoRA on Qwen2.5-Coder-14B
- `scripts/train_domain.py` — domain-specific LoRA training
- `scripts/improve.py` — weakness-targeted pair generation
- `scripts/gen_multiturn.py` — multi-turn conversation data generation
- `scripts/gen_verification_pairs.py` — verification data generation

---

## The Plan: 4 Phases

### Phase 1 — Data Generation Jobs (Week 1)

**What:** Let GPU workers generate training pairs for domains where the model is weak.

**Why first:** Embarrassingly parallel, no merge complexity, immediate value. Each worker produces independent JSONL output. No coordination needed between workers.

**New workload type:** `data_generation`

**Server-side changes (HivePoA):**
- No server changes needed — `data_generation` is already a defined workload type
- Job creation: coordinator specifies domain, count, model, prompt template in manifest
- Verification: structural validation (valid JSONL, correct field schema, no duplicates, no empty responses)

**Worker-side changes (Hive-AI):**
```
hiveai/compute/worker.py:
  Add _execute_data_generation(job) method:
    1. Parse manifest: domain, pair_count, model_name, server_url, prompt_template
    2. Spawn: python scripts/gen_pairs_worker.py \
         --domain {domain} --count {pair_count} \
         --server-url {server_url} --output /tmp/pairs_{job_id}.jsonl
    3. Parse output JSONL, validate structure
    4. Compute SHA-256, submit result with pair_count and sample pairs in result_json
```

**New script:**
```
scripts/gen_pairs_worker.py:
  - Takes domain + count + server_url
  - Uses existing improve.py weakness_hunter logic to generate prompts
  - Sends to local model (llama-server / Ollama)
  - Produces JSONL: {"instruction": "...", "response": "...", "domain": "...", "quality_score": 0.85}
  - Exits with count of valid pairs generated
```

**New verifier:**
```
hiveai/compute/verifier.py:
  Add DataGenerationVerifier:
    1. Structural check: valid JSONL, required fields present
    2. Dedup check: no duplicate instructions within the batch
    3. Quality sample: re-score 10% of pairs using the coordinator's own model
    4. Decision: PASS if ≥80% of sampled pairs score above quality threshold
```

**Manifest contract:**
```json
{
  "schema_version": 1,
  "workload_type": "data_generation",
  "domain": "rust",
  "pair_count": 50,
  "model_name": "qwen3:14b",
  "server_url": "http://localhost:11434/v1",
  "quality_threshold": 0.7,
  "prompt_template": "weakness_targeted"
}
```

**Result contract:**
```json
{
  "pairs_generated": 48,
  "pairs_valid": 45,
  "domain": "rust",
  "avg_quality_score": 0.82,
  "output_format": "jsonl",
  "sample_pairs": [{"instruction": "...", "response": "...", "quality_score": 0.85}]
}
```

**Payout:** Budget per job (e.g., 0.01 HBD per 50 pairs). Paid on verification pass.

**Acceptance test:**
1. Coordinator creates data_generation job for "rust" domain, 50 pairs
2. Worker claims, generates pairs via local model, submits JSONL
3. Verifier samples 10%, checks quality, approves
4. Payout settles

---

### Phase 2 — Domain LoRA Training Jobs (Week 2)

**What:** Workers train domain-specific LoRA adapters on their GPUs, upload the adapter weights.

**Why second:** Still embarrassingly parallel (each worker trains independently), but now produces model artifacts instead of data. No merge needed — each adapter is evaluated independently and the best one wins.

**New workload type:** `domain_lora_train`

**Worker-side changes:**
```
hiveai/compute/worker.py:
  Add _execute_domain_lora_train(job) method:
    1. Parse manifest: domain, base_model, dataset_url, epochs, lr, rank, max_steps
    2. Download dataset from IPFS/URL (manifest provides CID or URL)
    3. Spawn: python scripts/train_domain_worker.py \
         --base-model {base_model} --dataset {local_path} \
         --domain {domain} --epochs {epochs} --lr {lr} --rank {rank} \
         --output /tmp/adapter_{job_id}/
    4. SHA-256 the adapter directory (tar.gz)
    5. Submit: output_cid, adapter_size, final_loss, eval_score in result_json
```

**New script:**
```
scripts/train_domain_worker.py:
  - Wraps existing train_v5.py / train_domain.py logic
  - Loads base model via Unsloth (QLoRA, 4-bit)
  - Trains on provided dataset for specified steps
  - Saves adapter to output dir (~50-150 MB)
  - Runs quick eval (18-probe regression_eval.py --quick) on the result
  - Outputs: adapter path, final_loss, eval_scores JSON
```

**New verifier:**
```
hiveai/compute/verifier.py:
  Add DomainLoraTrainVerifier:
    1. Structural check: adapter files present (adapter_model.safetensors, adapter_config.json)
    2. Load adapter onto base model (coordinator must have base model available)
    3. Run hidden eval (18-probe quick regression_eval.py)
    4. Compare worker-reported score vs coordinator-measured score (15% tolerance)
    5. Decision: PASS if adapter loads cleanly and scores within tolerance
```

**Manifest contract:**
```json
{
  "schema_version": 1,
  "workload_type": "domain_lora_train",
  "domain": "rust",
  "base_model": "Qwen/Qwen2.5-Coder-14B-Instruct",
  "dataset_cid": "QmAbCdEf...",
  "dataset_format": "jsonl",
  "epochs": 2,
  "learning_rate": 2e-4,
  "lora_rank": 32,
  "max_steps": 2000,
  "min_vram_gb": 16,
  "eval_after_train": true
}
```

**Requirements:**
- Worker needs ≥16 GB VRAM (QLoRA on 14B model)
- Dataset downloaded from IPFS (existing IPFS integration in desktop agent)
- Adapter uploaded back (V1: SHA-256 reference, V1.1: IPFS pin)

**Payout:** Higher budget per job (e.g., 0.05-0.10 HBD per training run). Training uses more GPU time than eval.

---

### Phase 3 — Adapter Aggregation (Week 3-4)

**What:** Coordinator collects multiple domain LoRA adapters from different workers, merges them into an improved global adapter.

**Why third:** This is where the Bittensor-like "collective intelligence" emerges. Multiple workers each train on different data shards → coordinator merges the best adapters → better model than any single worker could produce.

**Architecture: Hub-and-spoke, NOT federated gradient sync.**

```
Worker A (rust shard 1) → trains → adapter_A (50 MB)
Worker B (rust shard 2) → trains → adapter_B (50 MB)
Worker C (python shard 1) → trains → adapter_C (50 MB)
                    ↓
           Coordinator collects all adapters
                    ↓
         Merge: dense-delta + truncated SVD
                    ↓
         Global adapter v6 (~50 MB)
                    ↓
         Full eval (60-probe regression_eval.py)
                    ↓
         If improved: broadcast as new baseline
```

**Merge algorithm (correct, not naive):**

```python
# WRONG (naive LoRA averaging):
# avg(B_i @ A_i) ≠ avg(B_i) @ avg(A_i)

# CORRECT (dense-delta + SVD):
def merge_adapters(adapters: list[LoRAAdapter], rank: int) -> LoRAAdapter:
    # 1. Reconstruct each adapter's dense delta
    deltas = [adapter.B @ adapter.A for adapter in adapters]

    # 2. Weighted average of dense deltas
    #    Weight by verification score (better adapters contribute more)
    weights = [adapter.verification_score for adapter in adapters]
    weights = normalize(weights)
    merged_delta = sum(w * d for w, d in zip(weights, deltas))

    # 3. Compress back to LoRA rank via truncated SVD
    U, S, Vh = torch.linalg.svd(merged_delta, full_matrices=False)
    new_B = U[:, :rank] @ torch.diag(torch.sqrt(S[:rank]))
    new_A = torch.diag(torch.sqrt(S[:rank])) @ Vh[:rank, :]

    return LoRAAdapter(A=new_A, B=new_B)
```

**New components:**

```
hiveai/compute/aggregator.py:
  class AdapterAggregator:
    - collect_adapters(job_ids: list[str]) → list[LoRAAdapter]
    - merge_dense_delta_svd(adapters, rank, weights) → LoRAAdapter
    - evaluate_merged(adapter, eval_probes) → score
    - publish_if_improved(adapter, score, current_baseline) → bool

scripts/merge_adapters.py:
  - CLI entry point for adapter aggregation
  - Downloads adapters from workers (IPFS or direct)
  - Runs merge_dense_delta_svd
  - Evaluates merged adapter
  - If improved: saves as new baseline, updates score_ledger.json
```

**Coordinator flow (runs on your machine or a trusted server):**
1. Create N training jobs (one per data shard)
2. Wait for all to complete + pass verification
3. Download verified adapters
4. Merge using dense-delta + SVD (weighted by verification score)
5. Evaluate merged adapter (full 60-probe eval)
6. If score improves over baseline: publish as new version
7. Broadcast new baseline to workers for next round

**This is NOT run on untrusted workers.** The coordinator does the merge. Workers only train and submit.

---

### Phase 4 — Multi-Round Federated Loop (Week 4+)

**What:** Automate the cycle: shard data → distribute to workers → collect adapters → merge → evaluate → broadcast new baseline → repeat.

**Architecture:**

```
Round 1:
  Coordinator shards dataset (e.g., 10 shards of 500 pairs each)
  Creates 10 domain_lora_train jobs
  Workers claim and train independently
  Coordinator merges → v6 adapter

Round 2:
  Coordinator re-shards (new random split for distribution balance)
  Workers now train starting from v6 adapter (not base model)
  Workers train → submit adapters
  Coordinator merges → v7 adapter

Round 3...N:
  Repeat until convergence or budget exhausted
```

**New components:**

```
scripts/federated_round.py:
  class FederatedCoordinator:
    - shard_dataset(dataset_path, num_shards) → list[shard_paths]
    - upload_shards_to_ipfs(shard_paths) → list[cids]
    - create_training_jobs(shard_cids, base_adapter, budget_per_job)
    - wait_for_completion(job_ids, timeout)
    - collect_and_merge(job_ids) → merged_adapter
    - evaluate_and_publish(merged_adapter) → bool
    - run_round() → RoundResult
    - run_multi_round(num_rounds) → list[RoundResult]
```

**When to use federated training:**
- NOT now (dataset is ~6k pairs — too small for multi-worker benefit)
- When dataset reaches 50k+ pairs
- When you have 3+ active GPU workers consistently

**Until then:** Use Phase 1-2 (data generation + independent domain LoRAs). The value is in generating MORE data and evaluating more configurations in parallel, not in federated gradient aggregation.

---

## Economic Model

### Job Pricing (HBD)

| Workload Type | Typical Duration | Suggested Budget | VRAM Required |
|--------------|-----------------|-----------------|---------------|
| `eval_sweep` | 5-30 min | 0.005-0.010 HBD | 8+ GB |
| `benchmark_run` | 5-20 min | 0.005-0.010 HBD | 8+ GB |
| `data_generation` | 10-30 min | 0.010-0.020 HBD | 8+ GB |
| `domain_lora_train` | 30-120 min | 0.050-0.100 HBD | 16+ GB |
| `adapter_validation` | 5-15 min | 0.005-0.010 HBD | 16+ GB |

### Worker Economics

- Worker earns HBD per completed + verified job
- Reputation builds over time (warm-up period: eval_sweep only for first 5 jobs)
- Higher reputation = access to higher-paying training jobs
- Verification failure = reputation penalty + no payout
- Workers can declare cached models → get priority for matching jobs

### Coordinator Economics

- Coordinator funds jobs from HBD budget (personal wallet or storage tier revenue)
- ROI: better model → more users → more storage tier subscriptions → more HBD
- Cost to train: ~0.50-1.00 HBD per full training round (10 workers × 0.05-0.10 each)
- Compare to cloud GPU: ~$0.50-2.00/hr for equivalent compute

---

## Security Model

### Trust Hierarchy

```
TRUSTED (runs on coordinator):
  - Job creation (what to compute)
  - Verification (re-run hidden eval)
  - Adapter merging (dense-delta + SVD)
  - Score tracking (score_ledger.json)
  - Payout decisions

UNTRUSTED (runs on workers):
  - Data generation (produces JSONL)
  - LoRA training (produces adapter weights)
  - Eval execution (produces scores)
  - All worker output verified before payout
```

### Attack Vectors & Mitigations

| Attack | Mitigation |
|--------|-----------|
| Worker submits fake scores | Verifier re-runs eval independently |
| Worker submits garbage adapter | Verifier loads adapter + runs hidden eval |
| Worker submits plagiarized data | Dedup check against existing dataset |
| Worker submits poisoned training data | Quality sampling + domain-specific validation |
| Sybil attack (many fake workers) | Warm-up reputation + Hive account age check |
| Worker re-submits same result | SHA-256 dedup on output artifacts |
| Worker runs for reward without GPU | Lease timeout + heartbeat enforcement |

### What We Do NOT Attempt to Prevent

- Workers seeing the training data (it's open — this is a public good)
- Workers copying the adapter (LoRAs are public artifacts)
- Workers running on cloud GPUs instead of local (fine — compute is compute)

---

## Implementation Order (What to Build)

### Week 1: data_generation workload
1. `scripts/gen_pairs_worker.py` — standalone pair generator script
2. `hiveai/compute/worker.py` — add `_execute_data_generation()` method
3. `hiveai/compute/verifier.py` — add `DataGenerationVerifier`
4. `hiveai/compute/models.py` — add `DataGenerationManifest` + `DataGenerationResult`
5. Test: `canary_compute.py --workload data_generation`
6. Update `gpu_worker.py` — add `data_generation` to default supported workloads

### Week 2: domain_lora_train workload
1. `scripts/train_domain_worker.py` — wraps train_v5.py for worker execution
2. `hiveai/compute/worker.py` — add `_execute_domain_lora_train()` method
3. `hiveai/compute/verifier.py` — add `DomainLoraTrainVerifier`
4. `hiveai/compute/models.py` — add `DomainLoraTrainManifest` + `DomainLoraTrainResult`
5. Test: canary with actual adapter training + verification

### Week 3: Adapter aggregation
1. `hiveai/compute/aggregator.py` — dense-delta + SVD merge
2. `scripts/merge_adapters.py` — CLI entry point
3. Integration test: create 2 training jobs → merge adapters → evaluate

### Week 4: Federated loop automation
1. `scripts/federated_round.py` — full round orchestration
2. Multi-round test: 2 rounds with 2 workers
3. Beta distribution for worker reliability scoring

---

## What GPT Should Review

1. **Is the phase ordering correct?** Data gen → training → merge → federated
2. **Is dense-delta + SVD the right merge for our LoRA rank (32)?** Or is FedEx-LoRA residual better?
3. **Is 0.05-0.10 HBD per training job economically viable?** What's the USD equivalent compute cost?
4. **Should we use multi-round from the start** or wait until 50k+ pairs?
5. **Is the verification model sound?** Re-running hidden eval is expensive — is sampling sufficient?
6. **What's missing from the security model?** Especially around data poisoning in training.
7. **Should adapters go to IPFS immediately** or is SHA-256 reference + direct download enough for V1?

---

## Files That Will Change

### Hive-AI (Python)
| File | Change |
|------|--------|
| `hiveai/compute/worker.py` | Add `_execute_data_generation()`, `_execute_domain_lora_train()` |
| `hiveai/compute/verifier.py` | Add `DataGenerationVerifier`, `DomainLoraTrainVerifier` |
| `hiveai/compute/models.py` | Add manifest/result dataclasses for new workload types |
| `hiveai/compute/aggregator.py` | **NEW** — adapter merge (dense-delta + SVD) |
| `scripts/gen_pairs_worker.py` | **NEW** — data generation executor |
| `scripts/train_domain_worker.py` | **NEW** — training executor (wraps train_v5.py) |
| `scripts/merge_adapters.py` | **NEW** — CLI adapter aggregation |
| `scripts/federated_round.py` | **NEW** — multi-round orchestration |
| `scripts/canary_compute.py` | Add data_generation + domain_lora_train canary flows |
| `tests/test_compute.py` | Add tests for new workload types |

### HivePoA (TypeScript) — Minimal Changes
| File | Change |
|------|--------|
| `server/services/compute-service.ts` | Add verification dispatch for new workload types |
| `server/routes.ts` | Settlement payout logic for training jobs (higher budget) |

### No Changes Needed
- Job claiming, leasing, heartbeat — already generic
- Node registration — already accepts any workload type string
- Database schema — `compute_jobs.workload_type` is already TEXT, not enum

---

## Success Criteria

**Phase 1 complete when:**
- A worker on machine B can generate 50 training pairs for machine A's model
- Pairs pass quality verification
- Worker earns HBD

**Phase 2 complete when:**
- A worker on machine B can train a LoRA adapter on a data shard
- Adapter passes hidden eval verification
- Worker earns HBD

**Phase 3 complete when:**
- 2+ adapters from different workers merge into a better adapter than any individual
- Merged adapter scores higher on 60-probe eval than the pre-merge baseline

**Phase 4 complete when:**
- Automated loop: shard → train → merge → evaluate → repeat
- 2+ rounds show monotonic improvement
- Total cost < $2 HBD per training round
