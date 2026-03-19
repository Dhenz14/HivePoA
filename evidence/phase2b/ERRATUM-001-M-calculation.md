# ERRATUM-001: Candidate M Values in Calibration Plan Table

## Scope

This erratum applies to the **Phase 2B Calibration Plan** (FROZEN 2026-03-18),
Section 2, "Candidate Class Definitions," specifically the table row
"Candidate M" for all three classes.

The frozen calibration plan is **not rewritten**. This document records the
correction alongside the frozen source.

## Error

The formula in the frozen document is correct:

```
M = floor(target_bytes / (N × 4))
```

The `× 4` term is `sizeof(uint32_t)` — the element size of matrix A, which is
`uint32_t A[M][N]` as defined in the normative C99 reference kernel
(`evidence/phase2a/phase2a_kernel_ref_v1.c`, line 561: `malloc(count_A * sizeof(uint32_t))`).

The table below the formula was computed as `M = target_bytes / N`, omitting
the `× 4` divisor. All three candidate M values in the table are 4× too large.

## Corrected Values

| Class | Frozen table M (WRONG) | Corrected M | Working set (M × N × 4) |
|---|---|---|---|
| gpu-small-v2 | 1,048,576 | **262,144** | 4,294,967,296 (4 GB) |
| gpu-medium-v2 | 2,097,152 | **524,288** | 8,589,934,592 (8 GB) |
| gpu-large-v2 | 3,145,728 | **786,432** | 12,884,901,888 (12 GB) |

## Verification

The corrected M=262,144 for gpu-small-v2 was used in Gate 4 precompute
measurement (2026-03-18). The kernel produced valid digests at this dimension
with golden vectors verified. Working set of 4 GB matches the design intent
(50% of 8 GB floor).

The frozen table's M=1,048,576 would produce a 16 GB A matrix allocation —
larger than the 8 GB positive control device's total VRAM. This confirms the
table values are erroneous.

## Impact on Frozen Methodology

None. The formula is correct. The 7-gate admissibility workflow is unchanged.
Hardware selection rules, compute-competitiveness verification, timing
measurement procedure, and all other frozen methodology items are unaffected.

Only the three numeric M values in the Section 2 planning table are corrected.
These values were explicitly marked as "planning estimates" in the frozen
document ("These M values are large. Precompute tractability must be verified
before committing to them.").

## Source Artifact

- Kernel source: `evidence/phase2a/phase2a_kernel_ref_v1.c` (frozen, golden vectors pass)
- Gate 4 measurement: `evidence/phase2b/gpu-small-v2-calibration.json`
- This erratum: `evidence/phase2b/ERRATUM-001-M-calculation.md`

## Filed

2026-03-18. Discovered during Gate 4 precompute measurement.
