# Proof of GPU Compute (PoGC) Blueprint

**SPK Network 2.0 — HivePoA + Hive-AI**
**Status:** Architecture designed, Phase 0 transaction integrity in progress
**Date:** 2026-03-16

---

## Executive Summary

PoGC extends HivePoA's existing Proof of Access (PoA) storage validation model to GPU compute. Miners share idle GPU capacity, validators issue random challenges to prove real hardware, and a proven GPU pool feeds both training jobs and inference tasks. Zero new chains, zero extra tokens, 100% Hive-native.

The system is built on battle-tested infrastructure already operational in both repos:
- HivePoA: 180+ API endpoints, 47 DB tables, multisig treasury (`@hivepoa-treasury` with real HBD flow), witness-rooted trust registry, PoA challenge engine
- Hive-AI: GPU worker runtime, eval harness, training pipeline, DBC node

---

## Architecture (3 Layers)

```
Layer 1: Hive Blockchain
├── custom_json for trust anchoring (registrations, bans, hash anchors)
├── @hivepoa-treasury multisig for HBD payouts
└── Witness-rooted WoT for validator eligibility

Layer 2: HivePoA Server (Coordinator + Validator)
├── ComputeService: job lifecycle, atomic claim, verification, settlement
├── TrustRegistryService: role-based eligibility (5 roles, quorum rules)
├── ChallengerService: VRAM-tiered liveness probes (NEW)
├── PostgreSQL: operational state (jobs, attempts, payouts, reputation)
└── Structured events: 15+ event types with full correlation keys

Layer 3: Hive-AI Worker (Miner)
├── GPUWorker: poll-claim-execute-submit loop
├── CheckpointStore: 8-stage durable crash recovery
├── Nonce echo: server-issued per-attempt, replay-safe
├── Provenance: structured metadata (identity + environment + derivation)
└── Desktop agent: Electron with "Share GPU ON/OFF" toggle
```

---

## What Already Exists (Operational)

### GPU Compute Marketplace (Phase 10)
- 5 tables: `computeNodes`, `computeJobs`, `computeJobAttempts`, `computeVerifications`, `computePayouts`
- 16 `/api/compute/*` endpoints
- Atomic job claim: `SELECT FOR UPDATE SKIP LOCKED` (race-safe)
- State machine: `queued → leased → running → submitted → verifying → accepted/rejected → settled`
- Three-stage payouts: validity_fee (30%) + completion_fee (40%) + bonus (30% × score)
- Warm-up reputation: nodes with rep < 20 restricted to safe workloads
- Cache-aware scheduling: prefers nodes with required models cached
- Lease sweeper: 30s interval, `leaseExpiresAt` as sole expiry oracle

### Transaction Integrity (Phase 0 — implemented, fault testing pending)
- **Server-issued nonce** per attempt (UUIDv4, echoed by worker on submit)
- **Idempotent replay**: exact replay returns cached result (zero side effects)
- **Divergent replay detection**: canonical framed payload hash (length-prefixed, versioned)
- **CAS acceptance**: `UPDATE ... WHERE accepted_attempt_id IS NULL` with rowcount check
- **DB-enforced single winner**: composite FK `(accepted_attempt_id, id) → attempts(id, job_id)`
- **Structured events**: 15 emitters covering full protocol lifecycle (claim, submit, accept, reject, expire, settle)
- **Worker checkpoints**: 8-stage durable state machine (atomic write-then-rename)
- **Crash recovery**: fail-closed for incomplete work, retry for ambiguous submit

### Trust Registry (Phase 11)
- Pure witness-rooted WoT (no HP weighting, no transitive chains)
- 5 roles: validator, treasury_signer, compute_verifier, oracle_runner, dbc_trainer
- Binary eligibility + quorum rules
- Fail-closed: HivePoA unreachable → eligible=false

### Treasury (Proven)
- 10 real-money soak cycles, 0.100 HBD, zero failures
- Exact on-chain reconciliation with `findTransaction()` + `confirmTransaction()`

---

## Phase 0: Transaction Integrity (Current)

### Binding Design Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Unit-of-work identity | Job (server UUID), Claim (attemptId + leaseToken + nonce), Settlement (payout rows) |
| D2 | Server state machine | 10 states + transition authority table, `settled` terminal |
| D3 | Lease expiry | `leaseExpiresAt` sole oracle, late submit → 409, provenance recorded |
| D4 | Provenance | 7 mandatory fields, rest advisory, ≤ 64 KB, validated before state mutation |
| D5 | Artifact trust | Hash-match at acceptance, coordinator-retrieval at settlement |
| D6 | Time authority | Server clock for everything, worker timestamps advisory |
| D7 | Acceptance vs settlement | Distinct thresholds, frozen payout inputs at acceptance |
| D8 | Mixed-version | No bump yet, hard cutover later, deterministic 400 rejection |

### Four Frozen Invariants

1. **Exactly one accepted attempt per job** — DB-enforced CAS
2. **Late iff server receipt > leaseExpiresAt** — sole oracle
3. **Exact replay idempotent, divergent replay conflict** — canonical hash
4. **Settlement from frozen inputs** — payout amounts snapshotted at acceptance

### Completion Gate

**Step 5: Fault injection** — 12 scenarios (7 single-fault, 3 compound, 2 ambiguous-success). Must prove: no duplicate semantic effects, no second winner, monotonic checkpoint recovery, full forensic reconstruction from events.

---

## Phase 1: Production Hardening

After Phase 0 fault injection passes:

1. **Mock → real Hive client** — replace mock with `@hiveio/dhive` witness lookups
2. **24-48h burn-in** — real witness rank data, low-value jobs
3. **IPFS artifact verification** — pin + readback + coordinator retrieval before settlement
4. **Settlement lifecycle** — `accepted → settled` when all payouts reach `confirmed`
5. **v1.2 backlog**: stuck-upload cleanup, challenge scheduling, lock-window reduction

---

## Phase 2: GPU Liveness & Anti-Cheat (Proof of GPU)

This is where PoGC diverges from pure job execution into active hardware verification.

**Container isolation prerequisite:** Training workloads (`domain_lora_train`) require containerized execution starting in Phase 2. Frozen Docker image with pinned deps, GPU passthrough, network isolation. Eval/benchmark workloads remain bare-process.

### VRAM-Tiered Liveness Challenges

Cheap proof-of-GPU separate from real workload verification. `compute_verifier` accounts (witnesses opted in via HivePoA dashboard, or WoT-vouched) issue random challenges to prove miners have real, responsive GPUs — even when no jobs are queued.

| Tier | VRAM | Challenge | Expected Runtime | Verification |
|------|------|-----------|-----------------|--------------|
| 1 | 8-16 GB | Deterministic matrix multiply (cuBLAS, fixed seed) | 2-4s | Known checksum |
| 2 | 16-24 GB | Small model inference (fixed prompts, exact token hash) | 3-6s | Deterministic output hash |
| 3 | 24+ GB | Micro LoRA forward pass on test shard | 4-8s | Loss value within tolerance |

**Key properties:**
- Challenge content is server-generated with nonce (prevents precomputation). Nonce must drive a large challenge family — a small prompt catalog with a huge seed is still a small challenge space.
- Response window: configurable, tight enough that "spin up on ping" fails
- Challenge frequency: Flat Poisson-distributed, per reputation tier: warm-up (rep 0-19) λ=2/hr, standard (rep 20-49) λ=1/hr, trusted (rep 50+) λ=0.5/hr. No adaptive scheduling in v1.
- Challenges are NOT job execution — they're liveness probes that run alongside real work
- All challenge/verification authority routes through `compute_verifier` role in the trust registry (same WoT opt-in pattern as storage validators and multisig signers)

### Hardware Fingerprinting

Workers submit signed hardware attestations that validators can verify:

```json
{
  "gpu_uuid": "GPU-abc123...",      // nvidia-smi UUID (stable per card)
  "driver_version_hash": "sha256:...", // driver identity
  "vram_total_bytes": 8589934592,    // exact, not rounded
  "cuda_compute_capability": "8.6",
  "attestation_nonce": "server-issued-nonce",
  "signature": "hive-key-signed-payload"
}
```

**What this proves:** The worker has a specific physical GPU with specific capabilities. Combined with challenge response timing, makes GPU spoofing (CPU fallback, wrong-tier GPU, VM without passthrough) detectable.

**What this does NOT prove:** Physical ownership vs cloud rental. That's fine — cloud GPUs are real GPUs. The goal is proving capability, not geography.

### Reputation Integration

Liveness challenges feed the existing reputation system:
- Pass → rep += 1 (slower than job completion, which gives rep += 2)
- Fail → rep -= 3 (faster penalty than job failure at -5, because liveness is easier)
- 3 consecutive liveness fails → temporary cooldown
- Persistent failure → ban via trust registry

### Miner Daemon UX

One-command GPU sharing via Electron desktop agent:

```
[Share GPU] toggle ON
  → auto-detect GPU specs (nvidia-smi, torch.cuda)
  → register with HivePoA (POST /api/compute/nodes/register)
  → enter poll loop (claim jobs + respond to liveness challenges)
  → background daemon < 50 MB RAM when idle
  → GPU sleeps between challenges/jobs
```

---

## Phase 3: Federated Training

**Concrete trigger gates (ALL must be met):**

| Gate | Threshold |
|------|-----------|
| Queue backlog | Sustained > 10 queued training jobs for 48+ hours |
| Verifier false-accept rate | < 5% on hidden eval audits over trailing 30 days |
| Stable worker pool | 3+ workers from 2+ distinct Hive accounts with rep ≥ 50 |
| Dataset size | ≥ 50k verified pairs across 3+ domains |
| Merge evaluation harness | Can detect 2% regression across domains within 1 round |

### Aggregation (NOT naive FedAvg)

LoRA factors (A, B matrices) cannot be averaged directly — `avg(B₁A₁, B₂A₂) ≠ B_avg × A_avg`. Instead:

1. **Dense-delta aggregation**: Each worker computes ΔW = BA (the dense weight delta)
2. **Weighted average** of dense deltas across workers
3. **Truncated SVD** to project back into low-rank form
4. **FedEx-LoRA** residual approach as exactness upgrade in later iterations

The aggregator is implemented behind a swappable `MergeStrategy` interface. Dense-delta + SVD is the Phase 3 default. Swap to FedEx-LoRA, QR fusion, or FedSA-style A/B separation based on observed regime.

### Job Types

| Type | Workers | Communication | Verification |
|------|---------|---------------|-------------|
| `eval_sweep` | 1 | None | Hidden re-run comparison |
| `benchmark_run` | 1 | None | Hidden re-run comparison |
| `domain_lora_train` | 1 | None | Loss curve + adapter quality (containerized) |
| `federated_lora` | N (coordinator assigns shards) | Coordinator collects deltas | Aggregated eval vs baseline |

**Per-account shard cap:** No single Hive account may hold more than 40% of shards in a federated round. Enforced at the job scheduler level.

> **Model-parallel (DEFERRED):** NCCL over WAN across untrusted nodes is a fundamentally different problem from federated LoRA. Not on the phase roadmap. Limited to vetted clusters under one operator or a tightly controlled LAN if ever needed.

### Data Integrity

- Stratified random sharding (preserve 72/28 direct/thinking-trace ratio)
- Private hidden eval suite (distinct from public `run_eval.py`)
- Behavioral canaries over trigger regexes for poisoning defense
- Domain-improvement weighting + capped diversity bonus for merge scoring

### New Tables

- `federated_runs` — multi-round training coordination
- `federated_rounds` — per-round aggregation state
- `federated_shards` — data shard assignments per worker per round

---

## Phase 4: Scale & Marketplace

- **Size-aware IPFS timeouts** + NAT workers default to HTTP artifact ingress (`POST /api/compute/artifacts/upload`)
- **Hybrid registry**: off-chain DB for speed + Hive custom_json hash anchors for auditability
- **Open job marketplace**: any Hive account can post compute jobs (eval, training, inference)
- **External verifier pool**: WoT-vouched `compute_verifier` accounts can serve as paid external verifiers (fee carved from job budget, bond + audit lottery for accountability)
- **HBD stablecoin advantage**: workers paid in pegged stablecoin, zero price risk vs TAO/NOS/AKT

---

## Economic Model

### Payout Structure (existing, proven)

```
Job acceptance triggers 3 frozen payout rows:
  Validity fee:   30% of budget  (always, for showing up)
  Completion fee: 40% of budget  (always, for finishing)
  Bonus:          30% × score    (quality-weighted)

Cancellation (partial work):
  min(0.8, elapsed/lease) × 30% of budget

Liveness challenges (Phase 2):
  Micro-HBD per pass (~0.001), funded from treasury
```

### Reputation Ladder (D2)

```
0-19:   Warm-up (eval + benchmark only)
20-49:  Standard (all V1 workloads)
50-79:  Trusted (priority scheduling, higher payout multiplier)
80-100: Elite (federated training eligible, cluster membership)
```

### Anti-Cheat Economics

Cheating is economically unprofitable because:
- Warm-up period (10+ successful jobs) before earning real money
- Reputation loss is 2.5× faster than gain (rep -5 on fail vs +2 on pass)
- Hardware fingerprint mismatch = immediate ban
- Liveness challenge failure = fast reputation drain
- Ban is on-chain (permanent until WoT appeal)

---

## Security Model

### Trust Model (SETTLED — Web of Trust)

All trust and governance routes through the existing HivePoA trust registry (Phase 11). Two participant types:

- **Workers** — anyone with a GPU and a Hive account. Untrusted. All work verified before payout. Self-register via `/api/compute/nodes/register`. Reputation earned through job completion.
- **Validators** — Hive witnesses (opted in via HivePoA dashboard) + WoT-vouched accounts. Trusted. Same opt-in pattern as storage validators and multisig signers. No new trust primitives.

The `compute_verifier` role in the trust registry (requires 2 vouches) covers both job verification and liveness challenge issuance. Hive accounts are the identity layer — no separate "operator" concept needed.

### Trust Boundaries

| Boundary | Who | Trust Level | Governance |
|----------|-----|-------------|------------|
| Job creation | Any Hive account with budget | Untrusted (manifest validated) | Self-service |
| Job execution | GPU worker | Untrusted (verified before payout) | Self-register, reputation-gated |
| Job verification | `compute_verifier` role (WoT) | Trusted | Witness opt-in or 2 vouches |
| Liveness challenges | `compute_verifier` role (WoT) | Trusted | Same as verification |
| Payout settlement | `treasury_signer` role (WoT) | Highly trusted | Witness opt-in or 3 vouches, multisig quorum |

### Attack Surfaces (addressed)

1. **Nonce replay** → server-issued per-attempt, echoed, verified
2. **Duplicate submit** → canonical payload hash, first-write-wins
3. **Double payout** → CAS acceptance, frozen payout inputs
4. **Fake GPU** → hardware fingerprint + timed liveness challenges
5. **Late work** → `leaseExpiresAt` sole oracle, always rejected
6. **Stale claim** → nonce scoped to attempt, new claim = new nonce
7. **Poisoned training** → behavioral canaries, hidden eval, capped diversity
8. **Settlement race** → payout rows frozen at acceptance, settlement reads snapshot
9. **Malicious worker patches local deps** → container isolation with pinned image SHA-256 (Phase 2+ training)
10. **One account dominates federated round** → per-account shard cap (40%) at scheduler level

---

## Implementation Roadmap

```
Phase 0  ████████████████░░  Transaction integrity (Steps 1-4 done, Step 5 pending)
Phase 1  ░░░░░░░░░░░░░░░░░░  Production hardening (mock→real Hive, burn-in, IPFS, HTTP artifact ingress)
Phase 2  ░░░░░░░░░░░░░░░░░░  GPU liveness + containerized training (challenges, fingerprint, daemon UX, Docker isolation)
Phase 3  ░░░░░░░░░░░░░░░░░░  Federated training (swappable aggregator, dense-delta SVD, sharding, canaries)
Phase 4  ░░░░░░░░░░░░░░░░░░  Scale & marketplace (open jobs, external verifier pool, hybrid registry)
```

> **Model-parallel:** Deferred indefinitely. Not a phase. Vetted-cluster-only if ever needed.

### Current State

| Repo | Commit | Tests | Status |
|------|--------|-------|--------|
| HivePoA | `18c0777` | 250 | Server integrity implemented |
| Hive-AI | `acb73f2` | 52 | Worker durability implemented |

### Next Milestone

**Phase 0 Step 5: Fault injection** — 12 adversarial scenarios proving the entire claim→execute→submit→accept→settle path is deterministic under crash, replay, race, and ambiguous-success conditions.

---

## Key Differentiators vs Existing GPU Networks

| Feature | Bittensor | Akash | Nosana | Salad | **HivePoA PoGC** |
|---------|-----------|-------|--------|-------|------------------|
| Payment token | TAO (volatile) | AKT (volatile) | NOS (volatile) | Salad Balance | **HBD ($1 pegged)** |
| New chain required | Yes | Yes | Yes (Solana) | No | **No (Hive L1)** |
| Anti-cheat | Weak (subnet-dependent) | None | Basic | Timing-based | **Nonce + fingerprint + timed challenges** |
| Worker crash recovery | None | None | None | None | **8-stage durable checkpoints** |
| Idempotent submission | No | No | No | No | **Canonical hash + CAS** |
| Federated training | No | No | No | No | **Dense-delta SVD (not naive FedAvg)** |
| Trust model | Subnet validators | Marketplace | Marketplace | Centralized | **Witness-rooted WoT** |
| On-chain settlement | Yes (slow) | Yes | Yes | No | **Hybrid (fast DB + hash anchors)** |

---

## Resolved Questions (formerly "Open Questions for Review")

All five original open questions have been resolved through three rounds of cross-AI review (Claude + GPT). Decisions are binding and documented in `GPU_SHARING_PLAN.md` v4.

1. **Liveness challenge frequency** — RESOLVED (D10): Flat Poisson, per-tier λ (warm-up: 2/hr, standard: 1/hr, trusted: 0.5/hr). Ops-configurable parameter, not frozen doctrine.

2. **Fingerprint spoofing resistance** — RESOLVED: Fingerprint is an identity continuity signal, not proof of compute. The real proof is passing unpredictable challenges within deadline. Fingerprint changes reset trust state.

3. **Federated training trigger** — RESOLVED: Five concrete operational gates (queue backlog, false-accept rate, worker pool diversity, dataset size, regression detection). All must be met. See Phase 3 trigger gates above.

4. **Validator incentive structure** — RESOLVED: v1 coordinator self-verifies (conscious deferral). v2 external verifier pool with explicit fee (10% of job budget), bond (10× fee), audit lottery (5%), and slash/reputation consequences. WoT-vouched `compute_verifier` role handles eligibility.

5. **Model-parallel feasibility** — RESOLVED: Deferred indefinitely. Not a phase. Vetted-cluster-only if ever needed. NCCL over WAN across untrusted nodes is a different class of system from federated LoRA.
