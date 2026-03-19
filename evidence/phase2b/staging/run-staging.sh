#!/usr/bin/env bash
# run-staging.sh — Phase 2B Staging Calibration: Full Orchestration
#
# One-shot script that seeds the DB, waits for precompute, runs challenges,
# and extracts timing data. Run this on the machine with the GPU.
#
# Prerequisites:
#   - HivePoA server running at localhost:3000
#   - PostgreSQL accessible at localhost:5432 (db=hivepoa, user=postgres)
#   - CUDA kernel compiled (evidence/phase2b/phase2a_kernel_gpu)
#   - C99 reference kernel compiled (evidence/phase2a/phase2a_kernel_ref_v1)
#     (needed by precompute worker for bundle generation)
#
# Usage:
#   cd evidence/phase2b/staging
#   chmod +x run-staging.sh gpu-staging-worker.sh extract-timing.sh
#   ./run-staging.sh [num_challenges] [profile_id]
#
# Default: 20 challenges against gpu-medium-v2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NUM_CHALLENGES="${1:-20}"
PROFILE_ID="${2:-staging-gpu-medium-v2}"
STAGES_PER_CHALLENGE=5
POOL_NEEDED=$((NUM_CHALLENGES + 5))  # headroom

echo "================================================================"
echo "Phase 2B Staging Calibration — Full Run"
echo "Date:       $(date -Iseconds)"
echo "Challenges: ${NUM_CHALLENGES}"
echo "Profile:    ${PROFILE_ID}"
echo "================================================================"
echo ""

# ── Step 1: Seed database ────────────────────────────────────────────────────

echo "--- Step 1: Seeding database ---"
psql -h localhost -U postgres -d hivepoa -f "${SCRIPT_DIR}/seed-staging-db.sql"
echo ""

# ── Step 2: Check precompute pool ────────────────────────────────────────────

echo "--- Step 2: Checking precompute pool ---"

POOL_COUNT=$(psql -h localhost -U postgres -d hivepoa -t -A -c "
    SELECT COUNT(DISTINCT challenge_set_id)
    FROM compute_challenge_stage_bundles
    WHERE profile_id = '${PROFILE_ID}'
      AND attempt_id IS NULL;
")
POOL_COUNT=$(echo "${POOL_COUNT}" | tr -d '[:space:]')

echo "  Pool count: ${POOL_COUNT} orphan sets"
echo "  Need:       ${POOL_NEEDED} sets minimum"

if [ "${POOL_COUNT}" -lt "${POOL_NEEDED}" ]; then
    echo ""
    echo "  Pool is low. The precompute worker generates bundles every 30s."
    echo "  For gpu-medium-v2, each bundle takes ~15s on CPU."
    echo "  Estimated wait: ~$((  (POOL_NEEDED - POOL_COUNT) * 15 / 5  ))s"
    echo ""
    echo "  Waiting for pool to fill..."

    MAX_WAIT=600  # 10 minutes max
    WAITED=0
    while [ "${POOL_COUNT}" -lt "${POOL_NEEDED}" ] && [ "${WAITED}" -lt "${MAX_WAIT}" ]; do
        sleep 15
        WAITED=$((WAITED + 15))
        POOL_COUNT=$(psql -h localhost -U postgres -d hivepoa -t -A -c "
            SELECT COUNT(DISTINCT challenge_set_id)
            FROM compute_challenge_stage_bundles
            WHERE profile_id = '${PROFILE_ID}'
              AND attempt_id IS NULL;
        " | tr -d '[:space:]')
        echo "    Pool: ${POOL_COUNT}/${POOL_NEEDED} (waited ${WAITED}s)"
    done

    if [ "${POOL_COUNT}" -lt "${POOL_NEEDED}" ]; then
        echo ""
        echo "  WARNING: Pool has ${POOL_COUNT} sets after ${MAX_WAIT}s wait."
        echo "  Proceeding anyway — worker will wait for refills if needed."
    fi
fi
echo ""

# ── Step 3: Run challenges ───────────────────────────────────────────────────

echo "--- Step 3: Running ${NUM_CHALLENGES} challenges ---"
echo ""

"${SCRIPT_DIR}/gpu-staging-worker.sh" "${NUM_CHALLENGES}" "${PROFILE_ID}"

# ── Step 4: Extract and analyze timing ───────────────────────────────────────

echo ""
echo "--- Step 4: Extracting timing data ---"
echo ""

"${SCRIPT_DIR}/extract-timing.sh" "${PROFILE_ID}"

echo ""
echo "================================================================"
echo "Staging calibration complete."
echo ""
echo "Gate 2 (compute-competitiveness): checked via GPU benchmarks"
echo "Gate 3 (protocol timing): data extracted above"
echo "================================================================"
