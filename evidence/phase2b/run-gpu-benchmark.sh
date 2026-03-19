#!/usr/bin/env bash
# run-gpu-benchmark.sh — Auto-detect GPU, compile CUDA kernel, run benchmarks
#
# Run this on any machine with an NVIDIA GPU and CUDA toolkit installed.
# It will detect the GPU model, compile for the correct architecture,
# verify correctness, and benchmark all Phase 2B profiles that fit in VRAM.
#
# Usage:
#   chmod +x run-gpu-benchmark.sh
#   ./run-gpu-benchmark.sh
#
# Prerequisites:
#   - NVIDIA GPU with driver installed (nvidia-smi must work)
#   - CUDA toolkit: sudo apt install nvidia-cuda-toolkit
#
# Output: gpu-benchmark-<hostname>-<date>.txt in the current directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
HOSTNAME="$(hostname)"
OUTFILE="${SCRIPT_DIR}/gpu-benchmark-${HOSTNAME}-${TIMESTAMP}.txt"

echo "=== HivePoA Phase 2B GPU Benchmark ==="
echo "Output will be saved to: ${OUTFILE}"
echo ""

# --- Step 1: Detect GPU ---
echo "--- Step 1: Detecting GPU ---"

if ! command -v nvidia-smi &>/dev/null; then
    echo "ERROR: nvidia-smi not found. Install NVIDIA drivers first."
    exit 1
fi

GPU_NAME=$(nvidia-smi --query-gpu=gpu_name --format=csv,noheader 2>/dev/null | head -1)
GPU_UUID=$(nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader 2>/dev/null | head -1)
GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
GPU_DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
CUDA_VER=$(nvidia-smi --query-gpu=cuda_version --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")

echo "  GPU:    ${GPU_NAME}"
echo "  UUID:   ${GPU_UUID}"
echo "  VRAM:   ${GPU_VRAM} MiB"
echo "  Driver: ${GPU_DRIVER}"
echo "  CUDA:   ${CUDA_VER}"
echo ""

# --- Step 2: Determine compute capability and nvcc arch ---
echo "--- Step 2: Determining compute capability ---"

if ! command -v nvcc &>/dev/null; then
    echo "ERROR: nvcc not found. Install CUDA toolkit:"
    echo "  sudo apt update && sudo apt install -y nvidia-cuda-toolkit"
    exit 1
fi

NVCC_VER=$(nvcc --version | grep "release" | sed 's/.*release //' | sed 's/,.*//')
echo "  nvcc version: ${NVCC_VER}"

# Detect compute capability from the GPU
# Try nvidia-smi first, fall back to a lookup table
COMPUTE_CAP=""
if nvidia-smi --query-gpu=compute_cap --format=csv,noheader &>/dev/null; then
    COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1)
fi

# If nvidia-smi doesn't report compute_cap, use a lookup table
if [ -z "${COMPUTE_CAP}" ] || [ "${COMPUTE_CAP}" = "[N/A]" ]; then
    case "${GPU_NAME}" in
        *"4090"*|*"4080"*|*"4070"*|*"4060"*)  COMPUTE_CAP="8.9" ;;
        *"3090"*|*"3080"*|*"3070"*|*"3060"*)  COMPUTE_CAP="8.6" ;;
        *"2080"*|*"2070"*|*"2060"*)            COMPUTE_CAP="7.5" ;;
        *"1660"*|*"1650"*)                     COMPUTE_CAP="7.5" ;;
        *"1080"*|*"1070"*|*"1060"*)            COMPUTE_CAP="6.1" ;;
        *)
            echo "  WARNING: Could not detect compute capability for '${GPU_NAME}'"
            echo "  Trying -arch=native (requires CUDA 11.5+)"
            COMPUTE_CAP="native"
            ;;
    esac
fi

# Convert compute cap to nvcc arch flag
if [ "${COMPUTE_CAP}" = "native" ]; then
    ARCH_FLAG="-arch=native"
else
    SM_VER=$(echo "${COMPUTE_CAP}" | tr -d '.')
    ARCH_FLAG="-arch=sm_${SM_VER}"
fi

echo "  Compute capability: ${COMPUTE_CAP}"
echo "  nvcc arch flag: ${ARCH_FLAG}"
echo ""

# --- Step 3: Compile ---
echo "--- Step 3: Compiling CUDA kernel ---"

SRC="${SCRIPT_DIR}/phase2a_kernel_gpu.cu"
BIN="${SCRIPT_DIR}/phase2a_kernel_gpu"

if [ ! -f "${SRC}" ]; then
    echo "ERROR: ${SRC} not found. Are you in the evidence/phase2b directory?"
    exit 1
fi

echo "  nvcc -O2 ${ARCH_FLAG} -o phase2a_kernel_gpu phase2a_kernel_gpu.cu"
nvcc -O2 ${ARCH_FLAG} -o "${BIN}" "${SRC}" 2>&1
echo "  Compiled successfully."
echo ""

# --- Step 4: Run everything and capture output ---
echo "--- Step 4: Running benchmarks (saving to ${OUTFILE}) ---"
echo ""

{
    echo "================================================================"
    echo "HivePoA Phase 2B GPU Benchmark"
    echo "Date: $(date -Iseconds)"
    echo "Host: ${HOSTNAME}"
    echo "================================================================"
    echo ""

    echo "=== nvidia-smi full output ==="
    nvidia-smi
    echo ""

    echo "=== nvidia-smi -L (GPU list) ==="
    nvidia-smi -L
    echo ""

    echo "=== GPU Info ==="
    "${BIN}" --info
    echo ""

    echo "=== Self-Test (golden vector verification) ==="
    "${BIN}" --selftest
    SELFTEST_RC=$?
    echo ""

    if [ ${SELFTEST_RC} -ne 0 ]; then
        echo "!!! SELF-TEST FAILED — STOPPING. Do not trust benchmark data. !!!"
        exit 1
    fi

    echo "=== Benchmark: gpu-small-v2 (M=262144 N=4096 K=8 r=1, 5 runs) ==="
    "${BIN}" --bench 262144 4096 8 1 5 || echo "SKIPPED (likely not enough VRAM)"
    echo ""

    echo "=== Benchmark: gpu-medium-v2 (M=524288 N=4096 K=8 r=2, 5 runs) ==="
    "${BIN}" --bench 524288 4096 8 2 5 || echo "SKIPPED (likely not enough VRAM)"
    echo ""

    echo "=== Benchmark: gpu-large-v2 (M=786432 N=4096 K=8 r=2, 5 runs) ==="
    "${BIN}" --bench 786432 4096 8 2 5 || echo "SKIPPED (likely not enough VRAM)"
    echo ""

    echo "================================================================"
    echo "Benchmark complete."
    echo "GPU: ${GPU_NAME} (${GPU_VRAM} MiB)"
    echo "UUID: ${GPU_UUID}"
    echo "================================================================"
} 2>&1 | tee "${OUTFILE}"

echo ""
echo "=== Done ==="
echo "Results saved to: ${OUTFILE}"
echo ""
echo "Next step: share this file back for calibration analysis."
