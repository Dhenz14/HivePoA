#!/usr/bin/env bash
# extract-timing.sh — Extract server-measured timing from staging calibration
#
# Queries the PostgreSQL database for Phase 2A checkpoint timing data.
# Computes calibration statistics (p50, p95, p99, σ, heavy-tail) for
# deadline formula derivation.
#
# The authoritative timing is: checkpoint_received_at - stage_issued_at
# (both server-side timestamps). This interval includes network RTT,
# GPU compute, and worker serialization — exactly the deployment signal.
#
# Usage:
#   ./extract-timing.sh [profile_id]
#
# Default: staging-gpu-medium-v2

set -euo pipefail

PROFILE_ID="${1:-staging-gpu-medium-v2}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-hivepoa}"
DB_USER="${DB_USER:-postgres}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="${SCRIPT_DIR}/calibration-timing-${PROFILE_ID}-${TIMESTAMP}.json"

echo "================================================================"
echo "Phase 2B Calibration Timing Extraction"
echo "Profile:  ${PROFILE_ID}"
echo "Database: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo "================================================================"
echo ""

# ── Raw stage-level timing ────────────────────────────────────────────────────

echo "=== Per-Stage Timing (server-measured) ==="
echo ""

psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "
SELECT
    c.attempt_id,
    c.stage_index,
    b.stage_issued_at,
    c.checkpoint_received_at,
    EXTRACT(EPOCH FROM (c.checkpoint_received_at - b.stage_issued_at)) * 1000 AS elapsed_ms,
    c.telemetry_json
FROM compute_challenge_checkpoints c
JOIN compute_challenge_stage_bundles b
    ON c.attempt_id = b.attempt_id AND c.stage_index = b.stage_index
WHERE b.profile_id = '${PROFILE_ID}'
ORDER BY c.checkpoint_received_at;
"

# ── Statistical summary ──────────────────────────────────────────────────────

echo ""
echo "=== Calibration Statistics ==="
echo ""

psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "
WITH stage_times AS (
    SELECT
        EXTRACT(EPOCH FROM (c.checkpoint_received_at - b.stage_issued_at)) * 1000 AS elapsed_ms
    FROM compute_challenge_checkpoints c
    JOIN compute_challenge_stage_bundles b
        ON c.attempt_id = b.attempt_id AND c.stage_index = b.stage_index
    WHERE b.profile_id = '${PROFILE_ID}'
),
ordered AS (
    SELECT elapsed_ms,
           ROW_NUMBER() OVER (ORDER BY elapsed_ms) AS rn,
           COUNT(*) OVER () AS total
    FROM stage_times
)
SELECT
    COUNT(*)                                              AS n_stages,
    ROUND(AVG(elapsed_ms)::numeric, 2)                   AS mean_ms,
    ROUND(STDDEV(elapsed_ms)::numeric, 2)                AS stddev_ms,
    ROUND(MIN(elapsed_ms)::numeric, 2)                   AS min_ms,
    ROUND(MAX(elapsed_ms)::numeric, 2)                   AS max_ms,
    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2) AS p50_ms,
    ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2) AS p90_ms,
    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2) AS p95_ms,
    ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2) AS p99_ms
FROM stage_times;
"

# ── Per-challenge summary ────────────────────────────────────────────────────

echo ""
echo "=== Per-Challenge Summary (5 stages each) ==="
echo ""

psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "
WITH challenge_times AS (
    SELECT
        c.attempt_id,
        SUM(EXTRACT(EPOCH FROM (c.checkpoint_received_at - b.stage_issued_at)) * 1000) AS total_ms,
        COUNT(*) AS stages
    FROM compute_challenge_checkpoints c
    JOIN compute_challenge_stage_bundles b
        ON c.attempt_id = b.attempt_id AND c.stage_index = b.stage_index
    WHERE b.profile_id = '${PROFILE_ID}'
    GROUP BY c.attempt_id
)
SELECT
    attempt_id,
    stages,
    ROUND(total_ms::numeric, 2) AS total_ms,
    ROUND((total_ms / stages)::numeric, 2) AS avg_stage_ms
FROM challenge_times
ORDER BY total_ms;
"

# ── Heavy-tail check ─────────────────────────────────────────────────────────

echo ""
echo "=== Heavy-Tail Check (p99/p50 ratio) ==="
echo ""

psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "
WITH stage_times AS (
    SELECT
        EXTRACT(EPOCH FROM (c.checkpoint_received_at - b.stage_issued_at)) * 1000 AS elapsed_ms
    FROM compute_challenge_checkpoints c
    JOIN compute_challenge_stage_bundles b
        ON c.attempt_id = b.attempt_id AND c.stage_index = b.stage_index
    WHERE b.profile_id = '${PROFILE_ID}'
)
SELECT
    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2) AS p50_ms,
    ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2) AS p99_ms,
    ROUND((PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms) /
           NULLIF(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY elapsed_ms), 0))::numeric, 3) AS heavy_tail_ratio,
    CASE
        WHEN PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms) /
             NULLIF(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY elapsed_ms), 0) < 3.0
        THEN 'PASS (ratio < 3.0, timing is stable)'
        ELSE 'WARNING: heavy tail detected (ratio >= 3.0)'
    END AS verdict
FROM stage_times;
"

# ── Deadline formula recommendation ──────────────────────────────────────────

echo ""
echo "=== Deadline Formula Candidates ==="
echo ""

psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "
WITH stage_times AS (
    SELECT
        EXTRACT(EPOCH FROM (c.checkpoint_received_at - b.stage_issued_at)) * 1000 AS elapsed_ms
    FROM compute_challenge_checkpoints c
    JOIN compute_challenge_stage_bundles b
        ON c.attempt_id = b.attempt_id AND c.stage_index = b.stage_index
    WHERE b.profile_id = '${PROFILE_ID}'
)
SELECT
    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 0) AS p50_ms,
    ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 0) AS p99_ms,
    ROUND(STDDEV(elapsed_ms)::numeric, 0) AS sigma_ms,
    ROUND((PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms) * 2)::numeric, 0) AS \"deadline_2x_p99\",
    ROUND((PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms) * 3)::numeric, 0) AS \"deadline_3x_p99\",
    ROUND((AVG(elapsed_ms) + 6 * STDDEV(elapsed_ms))::numeric, 0) AS \"deadline_mean+6σ\"
FROM stage_times;
"

echo ""
echo "Output saved to: ${OUTPUT_FILE}"
echo "================================================================"

# ── Export as JSON ────────────────────────────────────────────────────────────

psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -t -A -c "
WITH stage_times AS (
    SELECT
        EXTRACT(EPOCH FROM (c.checkpoint_received_at - b.stage_issued_at)) * 1000 AS elapsed_ms
    FROM compute_challenge_checkpoints c
    JOIN compute_challenge_stage_bundles b
        ON c.attempt_id = b.attempt_id AND c.stage_index = b.stage_index
    WHERE b.profile_id = '${PROFILE_ID}'
)
SELECT json_build_object(
    'profile_id', '${PROFILE_ID}',
    'extraction_date', NOW(),
    'n_stages', (SELECT COUNT(*) FROM stage_times),
    'mean_ms', ROUND(AVG(elapsed_ms)::numeric, 2),
    'stddev_ms', ROUND(STDDEV(elapsed_ms)::numeric, 2),
    'min_ms', ROUND(MIN(elapsed_ms)::numeric, 2),
    'max_ms', ROUND(MAX(elapsed_ms)::numeric, 2),
    'p50_ms', ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2),
    'p90_ms', ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2),
    'p95_ms', ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2),
    'p99_ms', ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 2),
    'heavy_tail_ratio', ROUND((PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY elapsed_ms) /
        NULLIF(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY elapsed_ms), 0))::numeric, 3)
)
FROM stage_times;
" > "${OUTPUT_FILE}"

echo "JSON exported: ${OUTPUT_FILE}"
