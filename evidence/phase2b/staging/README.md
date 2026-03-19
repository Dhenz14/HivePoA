# Phase 2B Staging Calibration

Run Phase 2A challenges on GPU through the full protocol to collect
server-measured timing data for deadline calibration.

**This is calibration tooling, NOT Phase 2B implementation.**
Uses existing Phase 2A infrastructure — no new routes, no new lifecycle.

---

## Quick Start

### 1. Start the server

```bash
# Terminal 1: start HivePoA server
npm run dev
```

Wait for: "Phase2AChallengeService: startup reconciliation complete, ready for issuance"

### 2. Compile CUDA kernel (if not already compiled)

```bash
# In WSL
cd /mnt/c/Users/theyc/Hive\ AI/HivePoA/evidence/phase2b
nvcc -O2 -arch=sm_89 -o phase2a_kernel_gpu phase2a_kernel_gpu.cu
```

### 3. Compile C99 reference kernel (needed for precompute)

```bash
# In WSL
cd /mnt/c/Users/theyc/Hive\ AI/HivePoA/evidence/phase2a
gcc -std=c99 -O2 -o phase2a_kernel_ref_v1 phase2a_kernel_ref_v1.c
```

### 4. Seed the database

```bash
psql -h localhost -U postgres -d hivepoa -f staging/seed-staging-db.sql
```

### 5. Wait for precompute pool

The server's precompute worker fills the pool automatically (checks every 30s).
For gpu-medium-v2, each bundle set takes ~15s on CPU. Pool target = 25 sets.

Monitor pool:
```bash
psql -h localhost -U postgres -d hivepoa -c "
    SELECT COUNT(DISTINCT challenge_set_id) AS pool_size
    FROM compute_challenge_stage_bundles
    WHERE profile_id = 'staging-gpu-medium-v2'
      AND attempt_id IS NULL;"
```

### 6. Run staging calibration

```bash
cd staging
chmod +x run-staging.sh gpu-staging-worker.sh extract-timing.sh
./run-staging.sh 20 staging-gpu-medium-v2
```

Or run steps individually:
```bash
# Run 20 challenges
./gpu-staging-worker.sh 20 staging-gpu-medium-v2

# Extract timing data
./extract-timing.sh staging-gpu-medium-v2
```

---

## What This Measures

The server records `checkpoint_received_at - stage_issued_at` for each stage.
This interval includes:
- Network RTT (localhost ≈ 0-1 ms)
- GPU compute (GEMM + mix)
- D2H memory copy
- CPU SHA-256 digest
- Worker serialization (JSON parse/format, curl overhead)
- Server request processing

This is the **deployment-realistic signal** for deadline calibration.

---

## New CUDA Kernel Modes

The CUDA kernel now supports two new modes for staging:

```bash
# --digest: mirrors C99 reference interface (root_nonce → stage_nonce + digest)
./phase2a_kernel_gpu --digest ROOT_NONCE CLASS_ID STAGE_INDEX M N K MIX_ROUNDS
# Output: stage_nonce=<hex>\ndigest=<hex>

# --compute: takes stage_nonce directly (used by staging worker)
./phase2a_kernel_gpu --compute STAGE_NONCE_HEX CLASS_ID STAGE_INDEX M N K MIX_ROUNDS
# Output: digest=<hex>\ngpu_ms=<float>\ntotal_ms=<float>
```

---

## Auth Credentials (staging only)

| Role | Auth header | Value |
|---|---|---|
| Coordinator | `Authorization: Bearer <token>` | `staging-coordinator-token-2026` |
| Worker | `Authorization: ApiKey <key>` | `staging-gpu-worker-apikey-2026` |

Node ID: `staging-node-rtx4070ti-001`

---

## File Inventory

| File | Purpose |
|---|---|
| `seed-staging-db.sql` | Insert profiles, session, API key, compute node |
| `gpu-staging-worker.sh` | GPU worker client (issues + processes challenges) |
| `extract-timing.sh` | Pull server-measured timing, compute statistics |
| `run-staging.sh` | Full orchestration (seed + wait + run + extract) |
| `provisional-gpu-small-v2-estimates.md` | BW-ratio estimates for 6-8 GB GPUs |
| `README.md` | This file |

---

## Profiles

| Profile ID | Class | M | N | K | Rounds | Working Set |
|---|---|---|---|---|---|---|
| `staging-gpu-medium-v2` | gpu-medium-v2 | 524,288 | 4096 | 8 | 2 | 8.59 GB |
| `staging-gpu-small-v2` | gpu-small-v2 | 262,144 | 4096 | 8 | 1 | 4.29 GB |
