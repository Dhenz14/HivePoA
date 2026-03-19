#!/usr/bin/env bash
# phase2b-calibrate.sh — Pre-staging candidate screening tool
#
# *** CALIBRATION ARTIFACT — NOT PRODUCT CODE ***
# *** PRE-STAGING ONLY — DOES NOT CLOSE ANY GATE ***
#
# Scope: candidate screening and identity capture.
# This script collects GPU identity metadata (via nvidia-smi) and runs
# the C99 reference kernel on CPU to verify kernel correctness at Phase 2B
# dimensions. It does NOT execute anything on the GPU.
#
# What this script DOES:
#   - Detects GPU model, VRAM, driver, tier classification
#   - Verifies the C99 reference kernel produces correct digests at
#     Phase 2B working-set sizes
#   - Measures CPU precompute timing (host envelope only)
#   - Produces a candidate-screening JSON for operator review
#
# What this script DOES NOT DO:
#   - Does not run any computation on the GPU
#   - Does not satisfy Gate 2 (compute-competitiveness requires actual
#     GPU execution of the reduced working set on both devices)
#   - Does not satisfy Gate 3 (full timing calibration requires actual
#     GPU execution through the staging challenge protocol)
#   - Does not produce admissible calibration evidence
#
# Gate 2 and Gate 3 require a deployed staging challenge server that
# issues challenges to worker nodes executing the kernel on GPU. The
# staging server does not exist yet. Until it does, this script is the
# extent of evidence collection possible.
#
# nvidia-smi detection alone is not admissible proof of device VRAM or
# compute capability. It is a self-reported claim that must be verified
# by actual GPU execution under the challenge protocol.
#
# Usage:
#   ./evidence/phase2b/phase2b-calibrate.sh <role> <class>
#
# Arguments:
#   role:  "positive" or "negative"
#   class: "gpu-small-v2" (others added after gpu-small-v2 is validated)
#
# Examples:
#   ./evidence/phase2b/phase2b-calibrate.sh positive gpu-small-v2   # 8 GB GPU node
#   ./evidence/phase2b/phase2b-calibrate.sh negative gpu-small-v2   # 6 GB GPU node
#
# Prerequisites:
#   - gcc (C99 support)
#   - /usr/bin/time (GNU time, not shell builtin)
#   - nvidia-smi (for GPU detection — self-reported, not verified)
#
# Output:
#   JSON file: evidence/phase2b/<class>-<role>-<hostname>-<date>.json
#   This output is a CANDIDATE SCREENING record, not admissible evidence.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KERNEL_SRC="$PROJECT_ROOT/evidence/phase2a/phase2a_kernel_ref_v1.c"
BUILD_DIR="/tmp/phase2b-calibration"
KERNEL_BIN="$BUILD_DIR/phase2a_kernel_ref_v1"
OUTPUT_DIR="$PROJECT_ROOT/evidence/phase2b"

# --- Phase 2B candidate dimensions (corrected M values) ---
# M = floor(target_bytes / (N × 4)), where target_bytes = floor_vram × 0.50
declare -A CLASS_M CLASS_N CLASS_K CLASS_MIX CLASS_ID
CLASS_M[gpu-small-v2]=262144
CLASS_N[gpu-small-v2]=4096
CLASS_K[gpu-small-v2]=8
CLASS_MIX[gpu-small-v2]=1
CLASS_ID[gpu-small-v2]=1

CLASS_M[gpu-medium-v2]=524288
CLASS_N[gpu-medium-v2]=4096
CLASS_K[gpu-medium-v2]=8
CLASS_MIX[gpu-medium-v2]=2
CLASS_ID[gpu-medium-v2]=2

# --- Argument parsing ---
if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <positive|negative> <gpu-small-v2|gpu-medium-v2>"
    exit 1
fi

ROLE="$1"
CLASS="$2"

if [[ "$ROLE" != "positive" && "$ROLE" != "negative" ]]; then
    echo "ERROR: role must be 'positive' or 'negative', got '$ROLE'"
    exit 1
fi

if [[ -z "${CLASS_M[$CLASS]+x}" ]]; then
    echo "ERROR: unknown class '$CLASS'. Available: ${!CLASS_M[*]}"
    exit 1
fi

M="${CLASS_M[$CLASS]}"
N="${CLASS_N[$CLASS]}"
K="${CLASS_K[$CLASS]}"
MIX="${CLASS_MIX[$CLASS]}"
CID="${CLASS_ID[$CLASS]}"
RUNS=10
HOSTNAME_SHORT="$(hostname | cut -d. -f1)"
DATE_TAG="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="$OUTPUT_DIR/${CLASS}-${ROLE}-${HOSTNAME_SHORT}-${DATE_TAG}.json"

echo "=== Phase 2B Calibration Runner ==="
echo "Role:    $ROLE"
echo "Class:   $CLASS"
echo "Dims:    M=$M N=$N K=$K mix_rounds=$MIX"
echo "Runs:    $RUNS"
echo "Output:  $OUTPUT_FILE"
echo ""

# --- GPU detection ---
echo "--- GPU Detection ---"
GPU_INFO="unknown"
GPU_VRAM_MB=0
DRIVER_VERSION="unknown"
CUDA_VERSION="unknown"

if command -v nvidia-smi &>/dev/null; then
    GPU_INFO=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")
    GPU_VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "0")
    DRIVER_VERSION=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")

    if command -v nvcc &>/dev/null; then
        CUDA_VERSION=$(nvcc --version 2>/dev/null | grep "release" | sed 's/.*release //' | sed 's/,.*//' || echo "unknown")
    fi
fi

GPU_VRAM_GB=$(echo "scale=1; $GPU_VRAM_MB / 1024" | bc 2>/dev/null || echo "unknown")

echo "GPU:     $GPU_INFO"
echo "VRAM:    ${GPU_VRAM_GB} GB (${GPU_VRAM_MB} MB)"
echo "Driver:  $DRIVER_VERSION"
echo "CUDA:    $CUDA_VERSION"
echo "OS:      $(uname -srm)"
echo ""

# --- Tier classification ---
TIER="unknown"
if [[ "$GPU_VRAM_MB" -gt 0 ]]; then
    if [[ "$GPU_VRAM_MB" -le 6144 ]]; then
        TIER="T1"
    elif [[ "$GPU_VRAM_MB" -le 12288 ]]; then
        TIER="T2"
    elif [[ "$GPU_VRAM_MB" -le 20480 ]]; then
        TIER="T3"
    elif [[ "$GPU_VRAM_MB" -le 49152 ]]; then
        TIER="T4"
    else
        TIER="T5"
    fi
fi
echo "Tier:    $TIER"

# --- Tier validation ---
if [[ "$ROLE" == "positive" && "$CLASS" == "gpu-small-v2" && "$TIER" != "T2" ]]; then
    echo ""
    echo "WARNING: Positive control for gpu-small-v2 requires T2 (7-12 GB)."
    echo "         Your GPU is $TIER ($GPU_VRAM_GB GB). Results may not be valid."
    echo "         Press Ctrl+C to abort, or wait 5 seconds to continue anyway."
    sleep 5
fi

if [[ "$ROLE" == "negative" && "$CLASS" == "gpu-small-v2" && "$TIER" != "T1" ]]; then
    echo ""
    echo "WARNING: Negative control for gpu-small-v2 requires T1 (≤6 GB)."
    echo "         Your GPU is $TIER ($GPU_VRAM_GB GB). Results may not be valid."
    echo "         Press Ctrl+C to abort, or wait 5 seconds to continue anyway."
    sleep 5
fi

echo ""

# --- Build kernel ---
echo "--- Building C99 reference kernel ---"
mkdir -p "$BUILD_DIR"
gcc -std=c99 -O2 -o "$KERNEL_BIN" "$KERNEL_SRC"
echo "Build OK: $KERNEL_BIN"
echo ""

# --- Verify golden vectors ---
echo "--- Verifying kernel integrity ---"
"$KERNEL_BIN" --verify
echo ""

# --- Run benchmark ---
echo "--- Running $RUNS benchmark iterations ---"
echo "Working set: $((M * N * 4 / 1048576)) MB (A matrix only)"
echo ""

TIMES_MS=()
PEAK_RSS_KB=0

for i in $(seq 1 $RUNS); do
    NONCE="calibration-${ROLE}-${HOSTNAME_SHORT}-run${i}"

    # Use GNU time for RSS measurement
    TIME_OUTPUT=$( { /usr/bin/time -v "$KERNEL_BIN" --digest "$NONCE" "$CID" 0 "$M" "$N" "$K" "$MIX" > /dev/null; } 2>&1 )

    WALL_SEC=$(echo "$TIME_OUTPUT" | grep "Elapsed (wall clock)" | sed 's/.*: //')
    USER_SEC=$(echo "$TIME_OUTPUT" | grep "User time" | sed 's/.*: //')
    RSS_KB=$(echo "$TIME_OUTPUT" | grep "Maximum resident" | sed 's/.*: //')

    # Parse wall time (handles m:ss and h:mm:ss formats)
    if [[ "$WALL_SEC" == *:*:* ]]; then
        # h:mm:ss
        WALL_MS=$(echo "$WALL_SEC" | awk -F: '{printf "%.0f", ($1*3600 + $2*60 + $3) * 1000}')
    else
        # m:ss or 0:ss.ss
        WALL_MS=$(echo "$WALL_SEC" | awk -F: '{printf "%.0f", ($1*60 + $2) * 1000}')
    fi

    TIMES_MS+=("$WALL_MS")

    if [[ "$RSS_KB" -gt "$PEAK_RSS_KB" ]]; then
        PEAK_RSS_KB="$RSS_KB"
    fi

    echo "  Run $i/$RUNS: wall=${WALL_SEC} user=${USER_SEC}s rss=${RSS_KB}KB → ${WALL_MS}ms"
done

echo ""
echo "Peak RSS: $((PEAK_RSS_KB / 1024)) MB"

# --- Compute statistics ---
# Sort times
IFS=$'\n' SORTED=($(sort -n <<<"${TIMES_MS[*]}")); unset IFS

COUNT=${#SORTED[@]}
MIN_MS="${SORTED[0]}"
MAX_MS="${SORTED[$((COUNT-1))]}"

# Median (p50)
if (( COUNT % 2 == 0 )); then
    P50_MS=$(( (SORTED[COUNT/2 - 1] + SORTED[COUNT/2]) / 2 ))
else
    P50_MS="${SORTED[$((COUNT/2))]}"
fi

# p95 index (for 10 samples, index 9 = max)
P95_IDX=$(( (COUNT * 95 + 99) / 100 - 1 ))
if [[ "$P95_IDX" -ge "$COUNT" ]]; then P95_IDX=$((COUNT-1)); fi
P95_MS="${SORTED[$P95_IDX]}"

# p99 (for 10 samples, = max)
P99_MS="$MAX_MS"

# p01 and p05 (for negative control)
P01_MS="$MIN_MS"
P05_IDX=$(( (COUNT * 5 + 99) / 100 - 1 ))
if [[ "$P05_IDX" -lt 0 ]]; then P05_IDX=0; fi
P05_MS="${SORTED[$P05_IDX]}"

# Sigma (standard deviation, integer approximation)
SUM=0
for t in "${TIMES_MS[@]}"; do SUM=$((SUM + t)); done
MEAN=$((SUM / COUNT))
SUMSQ=0
for t in "${TIMES_MS[@]}"; do
    DIFF=$((t - MEAN))
    SUMSQ=$((SUMSQ + DIFF * DIFF))
done
VARIANCE=$((SUMSQ / COUNT))
# Integer sqrt approximation
SIGMA=$(echo "scale=0; sqrt($VARIANCE)" | bc 2>/dev/null || echo "0")

echo ""
echo "--- Timing Statistics ---"
echo "  min:   ${MIN_MS} ms"
echo "  p50:   ${P50_MS} ms"
echo "  p95:   ${P95_MS} ms"
echo "  p99:   ${P99_MS} ms"
echo "  max:   ${MAX_MS} ms"
echo "  sigma: ${SIGMA} ms"
echo "  mean:  ${MEAN} ms"

# Heavy-tail check
if [[ "$P50_MS" -gt 0 ]]; then
    HEAVY_TAIL_X100=$(( P99_MS * 100 / P50_MS ))
    echo "  heavy_tail_ratio: ${HEAVY_TAIL_X100} / 100 = $(echo "scale=2; $HEAVY_TAIL_X100 / 100" | bc)"
    if [[ "$HEAVY_TAIL_X100" -gt 200 ]]; then
        echo "  WARNING: heavy_tail_ratio > 2.0 — environment may be unstable."
        echo "  See calibration plan Section 5.3 for remedies."
    fi
fi

# --- Write output JSON ---
mkdir -p "$OUTPUT_DIR"

TIMES_JSON=$(printf '%s\n' "${TIMES_MS[@]}" | jq -s '.')

cat > "$OUTPUT_FILE" << ENDJSON
{
  "role": "$ROLE",
  "class": "$CLASS",
  "hostname": "$HOSTNAME_SHORT",
  "collected_at": "$(date -Iseconds)",
  "device": {
    "model": "$GPU_INFO",
    "vram_mb": $GPU_VRAM_MB,
    "vram_gb": "$GPU_VRAM_GB",
    "driver_version": "$DRIVER_VERSION",
    "cuda_version": "$CUDA_VERSION",
    "tier": "$TIER",
    "os": "$(uname -srm)"
  },
  "profile": {
    "M": $M,
    "N": $N,
    "K": $K,
    "mix_rounds": $MIX,
    "working_set_mb": $((M * N * 4 / 1048576))
  },
  "benchmark": {
    "runs": $RUNS,
    "times_ms": $TIMES_JSON,
    "p50_ms": $P50_MS,
    "p95_ms": $P95_MS,
    "p99_ms": $P99_MS,
    "p01_ms": $P01_MS,
    "p05_ms": $P05_MS,
    "min_ms": $MIN_MS,
    "max_ms": $MAX_MS,
    "sigma_ms": $SIGMA,
    "mean_ms": $MEAN,
    "peak_rss_kb": $PEAK_RSS_KB,
    "peak_rss_mb": $((PEAK_RSS_KB / 1024))
  },
  "kernel": {
    "source": "evidence/phase2a/phase2a_kernel_ref_v1.c",
    "compile_flags": "-std=c99 -O2",
    "golden_vectors_verified": true
  },
  "evidence_status": "CANDIDATE SCREENING ONLY — NOT ADMISSIBLE CALIBRATION EVIDENCE",
  "evidence_scope": {
    "what_this_covers": "GPU identity capture (self-reported via nvidia-smi), CPU-side kernel correctness verification, host-envelope timing (CPU proxy only)",
    "what_this_does_NOT_cover": [
      "Gate 2: compute-competitiveness (requires actual GPU execution of reduced working set on both devices)",
      "Gate 3: full timing calibration (requires actual GPU execution through staging challenge protocol)",
      "Any gate closure or admissibility determination"
    ],
    "nvidia_smi_caveat": "GPU model, VRAM, and driver reported by nvidia-smi are self-reported device claims. They are not verified by this script. Verification requires actual GPU execution under the challenge protocol.",
    "cpu_timing_caveat": "All timing values in this record are CPU reference-kernel execution times. They measure host-side precompute cost. They say nothing about GPU execution speed, GPU compute-competitiveness, or GPU timing separation between positive and negative control devices."
  },
  "staging_dependency": "Gate 2 and Gate 3 require a deployed staging challenge server that issues challenges to worker nodes executing the kernel on the actual GPU. The staging server does not exist yet. This record cannot be promoted to admissible evidence without staging execution."
}
ENDJSON

echo ""
echo "=== Results written to: $OUTPUT_FILE ==="
echo ""
echo "This is a CANDIDATE SCREENING record."
echo "It captures GPU identity (self-reported) and verifies kernel correctness on CPU."
echo "It does NOT close any calibration gate."
echo ""
echo "Next steps:"
echo "  1. Share this file with the calibration operator (dandandan123)"
echo "  2. Operator reviews device identity against community-calibration-requirements.md"
echo "  3. If the device passes identity screening, it becomes a CANDIDATE"
echo "  4. The candidate is NOT ADMITTED until:"
echo "     - A staging challenge server is deployed"
echo "     - The device executes the kernel on its actual GPU through the challenge protocol"
echo "     - Gate 2 (compute-competitiveness) and Gate 3 (full timing) produce admissible evidence"
