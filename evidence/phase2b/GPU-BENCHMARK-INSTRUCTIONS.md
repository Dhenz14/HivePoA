# GPU Benchmark Instructions — Phase 2B Calibration

## Purpose

Run the CUDA kernel benchmark on a GPU to collect calibration timing data.
This measures how fast the GPU completes the Phase 2B challenge workload.

The benchmark produces identical digests to the C99 reference kernel — verified
by golden vector self-test before any measurement.

---

## Prerequisites

- NVIDIA GPU with CUDA support
- NVIDIA driver installed (check: `nvidia-smi`)
- CUDA toolkit with `nvcc` compiler
- Linux (native or WSL2 with GPU passthrough)

### Install CUDA toolkit (Ubuntu/WSL2)

```bash
sudo apt update
sudo apt install -y nvidia-cuda-toolkit
```

Verify: `nvcc --version` should show CUDA compilation tools.

---

## Quick Start

### 1. Compile

```bash
cd evidence/phase2b
nvcc -O2 -arch=native -o phase2a_kernel_gpu phase2a_kernel_gpu.cu
```

If `-arch=native` is not supported by your nvcc version, use the specific
architecture for your GPU:

| GPU | Architecture flag |
|---|---|
| RTX 4070/4060 (Ada) | `-arch=sm_89` |
| RTX 3070/3060 (Ampere) | `-arch=sm_86` |
| RTX 2060 (Turing) | `-arch=sm_75` |
| GTX 1660 (Turing) | `-arch=sm_75` |

### 2. Verify correctness

```bash
./phase2a_kernel_gpu --selftest
```

**Must see:** `RESULT: ALL PASS (3 vectors)`. If this fails, stop — the kernel
is not producing correct digests.

### 3. Check GPU info and VRAM

```bash
./phase2a_kernel_gpu --info
```

This shows: device name, VRAM total/free, compute capability, and whether each
Phase 2B profile fits in available VRAM.

**Important:** Close GPU-heavy apps (Ollama, AI inference, games) before
benchmarking. You need free VRAM:
- gpu-small-v2: needs ~4.3 GB free
- gpu-medium-v2: needs ~8.6 GB free
- gpu-large-v2: needs ~13.0 GB free

### 4. Run benchmarks

**All profiles at once:**
```bash
./phase2a_kernel_gpu --bench-profiles
```

**Single profile with 5 runs:**
```bash
# gpu-small-v2
./phase2a_kernel_gpu --bench 262144 4096 8 1 5

# gpu-medium-v2
./phase2a_kernel_gpu --bench 524288 4096 8 2 5

# gpu-large-v2
./phase2a_kernel_gpu --bench 786432 4096 8 2 5
```

### 5. Capture full output

Run everything and save to a file:

```bash
{
  echo "=== nvidia-smi ==="
  nvidia-smi

  echo ""
  echo "=== GPU Info ==="
  ./phase2a_kernel_gpu --info

  echo ""
  echo "=== Self-Test ==="
  ./phase2a_kernel_gpu --selftest

  echo ""
  echo "=== Benchmark: gpu-small-v2 (5 runs) ==="
  ./phase2a_kernel_gpu --bench 262144 4096 8 1 5

  echo ""
  echo "=== Benchmark: gpu-medium-v2 (5 runs) ==="
  ./phase2a_kernel_gpu --bench 524288 4096 8 2 5
} 2>&1 | tee gpu-benchmark-output.txt
```

---

## For the 12 GB GPU (Next Test)

This card is the **negative control candidate for gpu-medium-v2** (T2 ceiling,
12 GB). We need to measure:

1. **Does the gpu-medium-v2 working set (8.6 GB) fit?** With ~11 GB usable VRAM
   on a 12 GB card, it should fit but tight.

2. **How fast does it complete?** The RTX 4070 Ti SUPER (positive control, T3
   floor, 16 GB) averages 118 ms/stage for gpu-medium-v2. The negative control
   should be measurably slower.

3. **gpu-small-v2 timing:** The 4.3 GB working set fits easily on 12 GB. This
   gives us a T2 (non-floor) data point for gpu-small-v2.

### What to run on the 12 GB card

```bash
# Compile (use sm_86 for Ampere/RTX 3060 12GB, sm_89 for Ada)
nvcc -O2 -arch=sm_86 -o phase2a_kernel_gpu phase2a_kernel_gpu.cu

# Capture everything
{
  nvidia-smi
  ./phase2a_kernel_gpu --info
  ./phase2a_kernel_gpu --selftest
  ./phase2a_kernel_gpu --bench 262144 4096 8 1 5    # gpu-small-v2
  ./phase2a_kernel_gpu --bench 524288 4096 8 2 5    # gpu-medium-v2
} 2>&1 | tee gpu-benchmark-12gb-output.txt
```

### What we're looking for

| Measurement | Expected |
|---|---|
| gpu-small-v2 fits in VRAM | Yes (4.3 GB on 12 GB card) |
| gpu-medium-v2 fits in VRAM | Yes, tight (8.6 GB on ~11 GB usable) |
| gpu-medium-v2 stage time | Slower than 118 ms (positive control) |
| Golden vector self-test | ALL PASS (mandatory) |

---

## Existing Benchmark Data

### RTX 4070 Ti SUPER (16 GB, T3 floor) — 2026-03-18

| Profile | Working Set | Per Stage | Per Challenge |
|---|---|---|---|
| gpu-small-v2 | 4.29 GB | 59.2 ms | 296 ms |
| gpu-medium-v2 | 8.59 GB | 118.3 ms | 591 ms |
| gpu-large-v2 | 12.88 GB | 179.3 ms | 897 ms |

Full data: `gpu-benchmark-rtx4070ti-super.json`

---

## File Inventory

| File | Purpose |
|---|---|
| `phase2a_kernel_gpu.cu` | CUDA kernel source (compile with nvcc) |
| `gpu-benchmark-rtx4070ti-super.json` | RTX 4070 Ti SUPER timing data |
| `GPU-BENCHMARK-INSTRUCTIONS.md` | This file |
| `gpu-small-v2-calibration.json` | Partial calibration evidence (Gate 4 only) |
| `community-calibration-requirements.md` | Hardware pair spec + admissibility |
| `staging-measurement-contract-audit.md` | Timing contract audit |
| `ERRATUM-001-M-calculation.md` | Corrected M values |
| `phase2b-calibrate.sh` | Pre-staging screening (identity only) |
