#!/usr/bin/env bash
# gpu-staging-worker.sh — Phase 2B Staging Calibration Worker
#
# Runs N challenges through the Phase 2A challenge protocol using GPU compute.
# Server measures timing (checkpoint_received_at - stage_issued_at) which includes
# network RTT, GPU compute, worker serialization — exactly the calibration signal.
#
# Uses CUDA binary in --serve mode: one-time GPU init, then persistent process
# handles all stages. This avoids the ~3 minute CUDA context init per invocation
# on WSL2.
#
# Prerequisites:
#   1. HivePoA server running at $SERVER_URL
#   2. Database seeded (run seed-staging-db.sql first)
#   3. Precompute pool populated (server's precompute worker refills automatically)
#   4. CUDA kernel compiled (phase2a_kernel_gpu with --serve mode)
#
# Usage:
#   ./gpu-staging-worker.sh [num_challenges] [profile_id]
#
# Default: 20 challenges against gpu-medium-v2

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

SERVER_URL="${SERVER_URL:-http://localhost:5000}"
COORDINATOR_TOKEN="${COORDINATOR_TOKEN:-staging-coordinator-token-2026}"
WORKER_API_KEY="${WORKER_API_KEY:-staging-gpu-worker-apikey-2026}"
NODE_ID="${NODE_ID:-staging-node-rtx4070ti-001}"
PROFILE_ID="${2:-staging-gpu-medium-v2}"
NUM_CHALLENGES="${1:-20}"

# CUDA binary — look in script directory first, then PATH
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CUDA_BIN="${CUDA_BIN:-${SCRIPT_DIR}/../phase2a_kernel_gpu}"

# Max dimensions for --serve pre-allocation (gpu-medium-v2)
SERVE_MAX_M="${SERVE_MAX_M:-524288}"
SERVE_MAX_N="${SERVE_MAX_N:-4096}"
SERVE_MAX_K="${SERVE_MAX_K:-8}"

# ── Validate prerequisites ────────────────────────────────────────────────────

echo "================================================================"
echo "Phase 2B Staging Calibration Worker"
echo "Date:       $(date -Iseconds)"
echo "Server:     ${SERVER_URL}"
echo "Profile:    ${PROFILE_ID}"
echo "Node:       ${NODE_ID}"
echo "Challenges: ${NUM_CHALLENGES}"
echo "CUDA bin:   ${CUDA_BIN}"
echo "Serve dims: M=${SERVE_MAX_M} N=${SERVE_MAX_N} K=${SERVE_MAX_K}"
echo "================================================================"
echo ""

if [ ! -x "${CUDA_BIN}" ]; then
    echo "ERROR: CUDA binary not found or not executable: ${CUDA_BIN}"
    echo "Compile with: nvcc -O2 -arch=sm_89 -o phase2a_kernel_gpu phase2a_kernel_gpu.cu"
    exit 1
fi

# Quick server health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${SERVER_URL}/api/health" 2>/dev/null || echo "000")
if [ "${HTTP_CODE}" = "000" ]; then
    echo "ERROR: Cannot reach server at ${SERVER_URL}"
    exit 1
fi
echo "Server health: OK (${HTTP_CODE})"
echo ""

# ── Start CUDA serve process ─────────────────────────────────────────────────

# Named pipes for bidirectional communication with serve process
FIFO_IN=$(mktemp -u /tmp/cuda_serve_in_XXXXXX)
FIFO_OUT=$(mktemp -u /tmp/cuda_serve_out_XXXXXX)
mkfifo "${FIFO_IN}"
mkfifo "${FIFO_OUT}"

# Cleanup function
cleanup() {
    if [ -n "${CUDA_PID:-}" ] && kill -0 "${CUDA_PID}" 2>/dev/null; then
        echo "EXIT" > "${FIFO_IN}" 2>/dev/null || true
        wait "${CUDA_PID}" 2>/dev/null || true
    fi
    rm -f "${FIFO_IN}" "${FIFO_OUT}"
}
trap cleanup EXIT

echo "Starting CUDA serve process (one-time GPU init — may take a few minutes)..."
"${CUDA_BIN}" --serve "${SERVE_MAX_M}" "${SERVE_MAX_N}" "${SERVE_MAX_K}" \
    < "${FIFO_IN}" > "${FIFO_OUT}" 2>&1 &
CUDA_PID=$!

# Keep the FIFO_IN open for writing (otherwise the serve process sees EOF)
exec 3>"${FIFO_IN}"

# Wait for READY signal
echo "Waiting for GPU initialization..."
while IFS= read -r line; do
    if [[ "${line}" == *"READY"* ]]; then
        echo "GPU ready!"
        break
    fi
    # Print init messages (from stderr, mixed into stdout via 2>&1)
    echo "  [init] ${line}"
done < "${FIFO_OUT}"
echo ""

# ── Helper: send command to CUDA serve and read response ─────────────────────

gpu_compute() {
    local nonce_hex="$1"
    local cid="$2"
    local si="$3"
    local M="$4"
    local N="$5"
    local K="$6"
    local mr="$7"

    # Send command
    echo "${nonce_hex} ${cid} ${si} ${M} ${N} ${K} ${mr}" >&3

    # Read response until DONE
    RESULT_DIGEST=""
    GPU_MS=""
    TOTAL_MS=""
    while IFS= read -r line; do
        case "${line}" in
            digest=*)   RESULT_DIGEST="${line#digest=}" ;;
            gpu_ms=*)   GPU_MS="${line#gpu_ms=}" ;;
            total_ms=*) TOTAL_MS="${line#total_ms=}" ;;
            DONE)       break ;;
            ERROR*)     echo "    GPU ERROR: ${line}"; return 1 ;;
        esac
    done < "${FIFO_OUT}"

    if [ -z "${RESULT_DIGEST}" ]; then
        echo "    GPU compute returned no digest"
        return 1
    fi
    return 0
}

# ── Results tracking ──────────────────────────────────────────────────────────

RESULTS_FILE="${SCRIPT_DIR}/staging-results-$(date +%Y%m%d-%H%M%S).jsonl"
PASS_COUNT=0
FAIL_COUNT=0

# ── Run challenges ────────────────────────────────────────────────────────────

for i in $(seq 1 "${NUM_CHALLENGES}"); do
    echo "=== Challenge ${i}/${NUM_CHALLENGES} ==="

    # Step 1: Issue challenge (coordinator)
    ISSUE_RESP=$(curl -s -X POST "${SERVER_URL}/api/compute/challenges/issue" \
        -H "Authorization: Bearer ${COORDINATOR_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"nodeId\": \"${NODE_ID}\", \"profileId\": \"${PROFILE_ID}\"}")

    # Check for errors
    ISSUE_ERROR=$(echo "${ISSUE_RESP}" | jq -r '.error.code // empty' 2>/dev/null)
    if [ -n "${ISSUE_ERROR}" ]; then
        echo "  ISSUE FAILED: ${ISSUE_ERROR}"
        echo "  Response: ${ISSUE_RESP}"
        FAIL_COUNT=$((FAIL_COUNT + 1))

        if [ "${ISSUE_ERROR}" = "POOL_EXHAUSTED" ]; then
            echo ""
            echo "Pool exhausted. Waiting 120s for precompute worker to refill..."
            sleep 120
        fi
        continue
    fi

    ATTEMPT_ID=$(echo "${ISSUE_RESP}" | jq -r '.attemptId')
    JOB_ID=$(echo "${ISSUE_RESP}" | jq -r '.jobId')

    echo "  Job: ${JOB_ID}"
    echo "  Attempt: ${ATTEMPT_ID}"

    # Extract stage 0 from issue response
    STAGE_INDEX=$(echo "${ISSUE_RESP}" | jq -r '.stage.stageIndex')
    STAGE_NONCE=$(echo "${ISSUE_RESP}" | jq -r '.stage.stageNonce')
    M=$(echo "${ISSUE_RESP}" | jq -r '.stage.workloadParams.M')
    N=$(echo "${ISSUE_RESP}" | jq -r '.stage.workloadParams.N')
    K=$(echo "${ISSUE_RESP}" | jq -r '.stage.workloadParams.K')
    MIX_ROUNDS=$(echo "${ISSUE_RESP}" | jq -r '.stage.workloadParams.mix_rounds')
    CLASS_ID=$(echo "${ISSUE_RESP}" | jq -r '.stage.workloadParams.class_id')

    PREV_HASH=""
    FINAL="false"
    CHALLENGE_START=$(date +%s%N)
    STAGES_COMPLETED=0

    while [ "${FINAL}" != "true" ]; do
        STAGE_START=$(date +%s%N)

        # Step 2: Run GPU compute via serve process
        if ! gpu_compute "${STAGE_NONCE}" "${CLASS_ID}" "${STAGE_INDEX}" \
                         "${M}" "${N}" "${K}" "${MIX_ROUNDS}"; then
            echo "  CUDA compute failed at stage ${STAGE_INDEX}"
            FAIL_COUNT=$((FAIL_COUNT + 1))
            break
        fi

        # Step 3: Compute transcript entry hash
        # H(prevHash || stageIndex_decimal || resultDigest) — all ASCII concatenation
        ENTRY_HASH=$(printf '%s%s%s' "${PREV_HASH}" "${STAGE_INDEX}" "${RESULT_DIGEST}" | sha256sum | cut -d' ' -f1)

        # Step 4: Submit checkpoint (worker)
        CHECKPOINT_RESP=$(curl -s -X POST \
            "${SERVER_URL}/api/compute/challenges/${ATTEMPT_ID}/checkpoint" \
            -H "Authorization: ApiKey ${WORKER_API_KEY}" \
            -H "Content-Type: application/json" \
            -d "{
                \"stageIndex\": ${STAGE_INDEX},
                \"resultDigest\": \"${RESULT_DIGEST}\",
                \"stageNonce\": \"${STAGE_NONCE}\",
                \"transcriptPrevHash\": \"${PREV_HASH}\",
                \"transcriptEntryHash\": \"${ENTRY_HASH}\",
                \"telemetryJson\": \"{\\\"gpu_ms\\\": ${GPU_MS}, \\\"total_ms\\\": ${TOTAL_MS}}\"
            }")

        # Check for checkpoint errors
        CP_ERROR=$(echo "${CHECKPOINT_RESP}" | jq -r '.error.code // empty' 2>/dev/null)
        if [ -n "${CP_ERROR}" ]; then
            echo "  CHECKPOINT FAILED at stage ${STAGE_INDEX}: ${CP_ERROR}"
            echo "  Response: ${CHECKPOINT_RESP}"
            FAIL_COUNT=$((FAIL_COUNT + 1))
            break
        fi

        STAGE_END=$(date +%s%N)
        STAGE_ELAPSED_MS=$(( (STAGE_END - STAGE_START) / 1000000 ))

        FINAL=$(echo "${CHECKPOINT_RESP}" | jq -r '.final')
        STAGES_COMPLETED=$((STAGES_COMPLETED + 1))

        echo "  Stage ${STAGE_INDEX}: digest=${RESULT_DIGEST:0:16}... gpu=${GPU_MS}ms total=${TOTAL_MS}ms wall=${STAGE_ELAPSED_MS}ms"

        PREV_HASH="${ENTRY_HASH}"

        if [ "${FINAL}" != "true" ]; then
            # Extract next stage from checkpoint response
            STAGE_INDEX=$(echo "${CHECKPOINT_RESP}" | jq -r '.nextStage.stageIndex')
            STAGE_NONCE=$(echo "${CHECKPOINT_RESP}" | jq -r '.nextStage.stageNonce')
            # M, N, K, MIX_ROUNDS, CLASS_ID remain constant across stages
        fi
    done

    CHALLENGE_END=$(date +%s%N)
    CHALLENGE_ELAPSED_MS=$(( (CHALLENGE_END - CHALLENGE_START) / 1000000 ))

    if [ "${FINAL}" = "true" ]; then
        echo "  COMPLETE: ${STAGES_COMPLETED} stages in ${CHALLENGE_ELAPSED_MS}ms"
        PASS_COUNT=$((PASS_COUNT + 1))

        # Log result
        echo "{\"challenge\":${i},\"attemptId\":\"${ATTEMPT_ID}\",\"jobId\":\"${JOB_ID}\",\"stages\":${STAGES_COMPLETED},\"wall_ms\":${CHALLENGE_ELAPSED_MS},\"status\":\"pass\"}" >> "${RESULTS_FILE}"
    fi

    echo ""
done

# ── Shutdown serve process ────────────────────────────────────────────────────

echo "EXIT" >&3
exec 3>&-

# ── Summary ───────────────────────────────────────────────────────────────────

echo "================================================================"
echo "Staging Calibration Complete"
echo "  Passed:  ${PASS_COUNT}/${NUM_CHALLENGES}"
echo "  Failed:  ${FAIL_COUNT}/${NUM_CHALLENGES}"
echo "  Results: ${RESULTS_FILE}"
echo "================================================================"
echo ""
echo "Next: run extract-timing.sh to pull server-measured timing from DB"
