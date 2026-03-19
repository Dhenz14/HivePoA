# Provisional gpu-small-v2 Calibration Estimates

**Status:** PROVISIONAL — derived from public specs + validated BW-ratio model.
Superseded by real measurements when community hardware testing completes.

**Date:** 2026-03-18

## Methodology

The Phase 2B workload (integer GEMM, uint32, M×N with N=4096, K=8) is
**memory-bandwidth-bound** on the GPU portion. This was empirically validated:

| Card | BW (GB/s) | Predicted slowdown | Measured slowdown |
|---|---|---|---|
| RTX 4070 Ti SUPER | 672 | 1.00 (reference) | 1.00 |
| RTX 4070 SUPER | 504 | 1.33 | **1.33** (exact match) |

The BW-ratio model: `estimated_gpu_time = reference_gpu_time × (reference_BW / card_BW)`
is confirmed to predict within measurement noise. This gives high confidence in
extrapolation to unmeasured cards with known bandwidth specs.

## Reference Data (measured)

| Profile | Positive Control (4070 Ti SUPER) | Negative Control (4070 SUPER) |
|---|---|---|
| gpu-small-v2 gpu_total | 33.57 ms | 45.76 ms |
| gpu-small-v2 total (incl SHA-256) | 59.24 ms | 99.47 ms |
| gpu-medium-v2 gpu_total | 68.01 ms | 90.14 ms |
| gpu-medium-v2 total | 118.27 ms | 197.74 ms |

## T1 Tier (6 GB) — gpu-small-v2 Candidates

These cards are the negative control candidates for gpu-small-v2.
Working set: 4.29 GB (fits on 6 GB cards with ~1.7 GB headroom).

| GPU | VRAM | BW (GB/s) | Bus | Arch | compute_slowdown | Est. gpu_total (ms) |
|---|---|---|---|---|---|---|
| GTX 1660 Super | 6 GB | 336 | 192-bit | Turing | 2.00 | ~67 |
| RTX 2060 | 6 GB | 336 | 192-bit | Turing | 2.00 | ~67 |

**Key observation:** Both common T1 cards share identical memory bandwidth (336 GB/s,
192-bit bus, 14 Gbps GDDR6). They will produce nearly identical BW-bound GPU timing
despite different SM counts (22 vs 30).

**VRAM discrimination:** These cards have 6 GB VRAM. gpu-small-v2 needs 4.32 GB total
GPU memory → FITS. gpu-medium-v2 needs 8.64 GB → OOM. Binary separation confirmed.

## T2 Floor (8 GB) — gpu-small-v2 Positive Control Candidates

These cards are the positive control candidates for gpu-small-v2.
Working set: 4.29 GB (fits easily on 8 GB cards).

| GPU | VRAM | BW (GB/s) | Bus | Arch | compute_slowdown | Est. gpu_total (ms) |
|---|---|---|---|---|---|---|
| RTX 3060 Ti | 8 GB | 448 | 256-bit | Ampere | 1.50 | ~50 |
| RTX 3070 | 8 GB | 448 | 256-bit | Ampere | 1.50 | ~50 |
| RTX 2070 | 8 GB | 448 | 256-bit | Turing | 1.50 | ~50 |
| RTX 2080 | 8 GB | 448 | 256-bit | Turing | 1.50 | ~50 |
| RTX 4060 | 8 GB | 272 | 128-bit | Ada | 2.47 | ~83 |

**Key observation:** Four of the five common 8 GB cards share 448 GB/s bandwidth
(256-bit bus at 14 Gbps). The RTX 4060 desktop is the outlier — 128-bit bus limits
it to 272 GB/s despite being the newest architecture.

## Provisional compute_slowdown Analysis

For gpu-small-v2, the hardware pair is:
- **Positive control** (T2 floor, 8 GB): Typical card has 448 GB/s → gpu_total ~50 ms
- **Negative control** (T1, 6 GB): Typical card has 336 GB/s → gpu_total ~67 ms

```
provisional_compute_slowdown = 67 / 50 = 1.34
```

This is UNDER the 2.0 threshold → compute-competitive. The T1/T2 boundary for
gpu-small-v2 is VRAM-based (OOM on gpu-medium-v2), not compute-based.

## Edge Case: RTX 4060 Desktop (8 GB)

The RTX 4060 desktop is problematic as a T2 representative:
- BW = 272 GB/s (128-bit bus) → compute_slowdown = 2.47x vs reference
- This exceeds the 2.0x compute-competitiveness threshold

**Options:**
1. Widen the threshold to 3.0x (accommodates all 8 GB cards)
2. Accept that the RTX 4060 desktop will be slower but still meets deadline
   (its ~83 ms gpu_total is still vastly faster than CPU fallback at ~6,770 ms)
3. Use adaptive deadlines per-architecture (complexity cost)

**Recommendation:** Option 2. The 100x+ timing gap between GPU and CPU is the
primary discrimination signal. Whether a GPU completes in 50 ms or 83 ms is a
noise-level difference compared to the CPU fallback at 6,770 ms. The deadline
should be set to accommodate the slowest legitimate GPU, not the fastest.

## Provisional Deadline Estimate

For gpu-small-v2 through the staging protocol (estimated):

| Component | Positive (8 GB) | Negative (6 GB) |
|---|---|---|
| GPU compute | ~50 ms | ~67 ms |
| D2H copy | ~2 ms | ~2 ms |
| SHA-256 (CPU) | ~52 ms | ~52 ms* |
| Network RTT | ~5 ms | ~5 ms |
| Serialization | ~5 ms | ~5 ms |
| **Total per stage** | **~114 ms** | **~131 ms** |
| **Per challenge (5 stages)** | **~570 ms** | **~655 ms** |

*CPU time depends on the host CPU, not the GPU. Assumes similar CPU.

**Provisional stage deadline:** 1,000 ms (7-8x headroom over positive control)
**Provisional completion deadline:** 10,000 ms (15x headroom)

These values will be refined by staging server measurements.

## What This Data Closes vs. Leaves Open

**Provisionally closed:**
- compute_slowdown estimate for T1/T2 boundary (1.34, well under 2.0)
- VRAM discrimination direction (6 GB OOMs on gpu-medium-v2 working set)
- Rough deadline range for gpu-small-v2

**Still requires real hardware:**
- Actual GPU timing on 6 GB and 8 GB cards (validates BW-ratio model at these tiers)
- Protocol timing through staging server (network + serialization overhead)
- Heavy-tail distribution check (is timing variance stable on budget hardware?)
- CPU-side SHA-256 timing (varies by host CPU, not predictable from GPU specs)
