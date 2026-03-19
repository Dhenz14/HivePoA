# Community Calibration Requirements — gpu-small-v2

## Purpose

This document specifies what is needed from community volunteers to close
Gates 1–3 of the `gpu-small-v2` calibration. It is addressed to the
calibration operator (dandandan123) and to any volunteer who offers hardware.

This is **evidence collection**, not product deployment. No software is
installed on the volunteer's node beyond compiling and running the C99
reference kernel. No account, registration, or network participation is
required.

---

## Hardware Pair Recruitment

Two specific devices are needed. Not "any GPU." Boundary closeness matters
more than broad participation at this stage.

### Positive Control — one device

| Requirement | Value |
|---|---|
| VRAM tier | T2 (7–12 GB) |
| Exact target | **8 GB single-device GPU** |
| Acceptable devices | RTX 3070 8GB (Ampere), RTX 4060 Ti 8GB (Ada), RTX 3060 Ti 8GB (Ampere) |
| Not acceptable | 10 GB or 12 GB devices (not floor-level), multi-GPU, vGPU, integrated graphics |
| Architecture | NVIDIA Ampere or Ada Lovelace preferred (compute-competitive with negative control) |
| Single-device rule | The GPU must be a single physical device, not an SLI/NVLink pair, not a cloud vGPU partition unless that vGPU has exactly 8 GB effective VRAM |
| Why 8 GB specifically | The positive control must be the worst-case conforming device — the minimum-qualifying GPU for the class. An 8 GB device sits at the floor of T2. A device above the floor produces artificially fast timing, tightening the deadline band beyond what floor-level nodes can meet. |

### Negative Control — one device

| Requirement | Value |
|---|---|
| VRAM tier | T1 (≤ 6 GB) |
| Exact target | **6 GB single-device GPU** |
| Acceptable devices | RTX 2060 6GB (Turing), GTX 1660 Super 6GB (Turing), GTX 1660 Ti 6GB (Turing) |
| Not acceptable | 4 GB devices (too far from boundary — trivially passes), 8 GB devices (wrong tier), multi-GPU, integrated |
| Architecture | NVIDIA Turing preferred (one generation behind Ampere — needs compute-competitiveness check) |
| Boundary-closeness | The negative control must be the **hardest case for the adversary**: the highest-VRAM device below the class floor. 6 GB is the T1 ceiling. A 4 GB device makes separation trivially easy and doesn't stress the boundary. |
| Compute-competitive | Must be broadly compute-competitive with the positive control. Same NVIDIA architecture generation is ideal. Cross-generation is acceptable if `compute_slowdown ≤ 2.0` (see checklist below). |

### What to ask volunteers

Do NOT ask: "Does anyone have a spare GPU?"

DO ask: "We need exactly two volunteers for a 30-minute calibration run:
1. Someone with a single RTX 3070 8GB (or RTX 4060 Ti 8GB, or RTX 3060 Ti 8GB)
2. Someone with a single RTX 2060 6GB (or GTX 1660 Super 6GB, or GTX 1660 Ti 6GB)

You'll compile a small C program, run it 10 times, and send us the output JSON. Nothing is installed. No network access needed. Takes about 15 minutes."

---

## First Community Run — Admissibility Checklist

When a volunteer comes forward, the calibration operator must verify each
item before accepting the evidence. Check each box. Any unchecked box blocks
acceptance.

### Device Identity (both devices)

- [ ] Volunteer provides `nvidia-smi` output showing exactly one GPU
- [ ] Reported VRAM matches expected value (8192 MB for positive, 6144 MB for negative)
- [ ] No host-aggregate interpretation: the device is a single physical GPU, not
      "total system VRAM across multiple devices"
- [ ] Driver version and CUDA version (if applicable) documented
- [ ] OS and kernel version documented

### Positive Control Admissibility

- [ ] Device VRAM is in T2 range (7–12 GB)
- [ ] Device VRAM is at or near the 8 GB floor (not 10 GB or 12 GB)
- [ ] Device is a single logical GPU (confirmed via `nvidia-smi -L` showing one entry)
- [ ] Architecture generation documented (Ampere, Ada Lovelace, etc.)

### Negative Control Admissibility

- [ ] Device VRAM is in T1 range (≤ 6 GB)
- [ ] Device VRAM is boundary-close: 6 GB, not 4 GB or less
- [ ] Device is a single logical GPU
- [ ] Architecture generation documented

### Pre-Staging Candidate Screening Outcome

If all identity checks above pass for both devices, they are **IDENTIFIED
CANDIDATES**. They are NOT admitted. Identification means:

- The devices exist and are plausibly the right tier and VRAM
- The nvidia-smi self-report is consistent with the target spec
- The C99 reference kernel runs correctly at Phase 2B dimensions on the
  host CPU (kernel integrity check, not GPU execution)

**nvidia-smi detection alone is not admissible proof.** It is a self-reported
claim. Verification requires actual GPU execution under the challenge protocol.

The screening tool (`phase2b-calibrate.sh`) produces a candidate-screening
JSON. This JSON is stored in `evidence/phase2b/` but is explicitly marked
as non-admissible.

---

## Surface 2: Staging Execution (Gates 2 and 3)

**This surface does not exist yet.** It requires a deployed staging challenge
server. The staging server is not built. No work item in this document covers
building it — that is implementation work, and implementation is blocked until
calibration methodology is satisfied.

When a staging server exists, the following must be executed on it:

### Gate 2 — Compute-Competitiveness (requires actual GPU execution)

Run the reduced-working-set throughput ratio test per calibration plan
Section 4.3. **This must execute on the actual GPU, not on CPU.**

```
reduced_target_bytes = floor(min(negative_vram, positive_vram) × 0.5)
                     = floor(6 GB × 0.5) = 3 GB
reduced_M = floor(3,221,225,472 / (4096 × 4)) = 196,608
```

Execute on both devices, 10 runs each, **on the GPU through the staging
challenge protocol** (not the CPU reference kernel). Measure GPU-side
execution time.

Then compute:

```
compute_slowdown = negative_gpu_median_time / positive_gpu_median_time
```

- [ ] `compute_slowdown` calculated from **actual GPU execution medians**
- [ ] If `compute_slowdown ≤ 2.0`: compute-competitive. **PASS.**
- [ ] If `2.0 < compute_slowdown ≤ 4.0`: marginal. Written justification
      required. Acceptable only with explicit documentation.
- [ ] If `compute_slowdown > 4.0`: **FAIL.** Select a different negative
      control device.

**CPU reference-kernel timing is not sufficient for Gate 2.** A CPU benchmark
says nothing decisive about the relative compute behavior of the two GPUs.

### Gate 3 — Full Timing Calibration (requires staging challenge protocol)

Per calibration plan Section 5.2. Deploy staging server with candidate
profile. Issue 20 full challenges per device (100 stage timing measurements
each) through the actual challenge protocol. Measure
`checkpoint_received_at − stage_issued_at` server-side.

- [ ] 20 challenges on positive control through staging protocol
- [ ] 20 challenges on negative control through staging protocol
- [ ] Positive control distribution: p50, p95, p99, σ computed
- [ ] Heavy-tail check: `p99/p50 ≤ 2.0`
- [ ] Deadline derived per Section 5.3 formula
- [ ] Separation margin check per Section 5.4
- [ ] Class-definition drift check: `working_set_fraction ≤ 0.65`

### Admission

A device pair is ADMITTED only when:

- [ ] Pre-staging identity checks pass (Surface 1)
- [ ] Gate 2 compute-competitiveness passes with **actual GPU medians**
- [ ] Gate 3 full timing calibration passes with **staging protocol data**
- [ ] All evidence is recorded in the calibration evidence template

### What This Closes vs. What Remains Open

If both surfaces pass:
- Gate 1 (pre-calibration): closed
- Gate 2 (hardware qualification): closed
- Gate 3 (full timing calibration): closed

Still open even after Surface 2 passes:
- Gate 5 (evidence compilation) — assemble final record
- Gate 6 (profile row insertion) — requires insertion governance
- Gate 7 (post-insertion validation) — requires production deployment
- gpu-medium-v2 calibration (blocked by insertion order)
- Phase 2B implementation (blocked until calibration is complete)

---

## File Inventory

All calibration artifacts live in `evidence/phase2b/`:

| File | Purpose | Surface |
|---|---|---|
| `gpu-small-v2-calibration.json` | Partial evidence record (Gate 4 only, NOT CERTIFIED) | Pre-staging |
| `ERRATUM-001-M-calculation.md` | Corrected M values (frozen plan not rewritten) | Pre-staging |
| `phase2b-calibrate.sh` | Pre-staging screening only; not admissible evidence; does not close any gate | Pre-staging |
| `community-calibration-requirements.md` | This document | Both |
| `staging-measurement-contract-audit.md` | Audit/verification artifact: timing contract inherited from Phase 2A (not a new spec) | Both |

No staging-execution artifacts exist yet. They will be created when the
staging challenge server is deployed and the device pair executes through it.
