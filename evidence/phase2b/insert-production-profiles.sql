-- insert-production-profiles.sql — Phase 2B Production Profile Insertion
--
-- Inserts production gpu-small-v2 and gpu-medium-v2 profiles with calibration-derived deadlines.
-- Deactivates staging profiles to prevent precompute worker from refilling them.
--
-- Evidence basis:
--   gpu-medium-v2: evidence/phase2b/gpu-medium-v2-calibration.json (CERTIFIED, Gates 1-5 closed)
--   gpu-small-v2:  evidence/phase2b/gpu-small-v2-calibration.json (PROVISIONAL, BW-ratio model)
--
-- Usage:
--   psql -h localhost -U postgres -d hivepoa -f insert-production-profiles.sql
--
-- Idempotent: ON CONFLICT DO NOTHING.

BEGIN;

-- ============================================================
-- Deactivate staging profiles (no longer needed for calibration)
-- ============================================================
UPDATE compute_resource_class_profiles
SET is_active = false
WHERE profile_id IN ('staging-gpu-medium-v2', 'staging-gpu-small-v2');

-- ============================================================
-- gpu-small-v2 Production Profile
--
-- Calibration: PROVISIONAL (BW-ratio model estimates)
-- Deadline basis: estimated T2-floor staging p99 ~109ms x 3.2 = 350ms
-- Working set: 4.29 GB (M=262144, N=4096, K=8, mix_rounds=1)
-- ============================================================
INSERT INTO compute_resource_class_profiles (
  profile_id, class_id, class_name,
  protocol_version, kernel_id,
  m, n, k, mix_rounds,
  stages_per_challenge,
  first_progress_deadline_ms, stage_deadline_ms, completion_deadline_ms,
  pool_target, pool_low_watermark_pct, pool_critical_watermark_pct,
  is_active
)
VALUES (
  'prod-gpu-small-v2',
  201,                          -- class_id for production gpu-small-v2
  'gpu-small-v2',
  2,                            -- protocol_version 2 (production)
  'phase2a-kernel-v1',
  262144, 4096, 8, 1,           -- M, N, K, mix_rounds
  5,                            -- stages_per_challenge
  10000,                        -- first_progress_deadline_ms (10s)
  350,                          -- stage_deadline_ms (3.2x estimated T2-floor p99)
  10000,                        -- completion_deadline_ms (10s for 5 stages)
  20,                           -- pool_target
  50,                           -- pool_low_watermark_pct
  25,                           -- pool_critical_watermark_pct
  true                          -- is_active
)
ON CONFLICT (protocol_version, class_id) DO NOTHING;

-- ============================================================
-- gpu-medium-v2 Production Profile
--
-- Calibration: CERTIFIED (Gates 1-5 closed)
-- Deadline basis: staging clean p99=157ms x 3.2 = 500ms
-- Working set: 8.59 GB (M=524288, N=4096, K=8, mix_rounds=2)
-- ============================================================
INSERT INTO compute_resource_class_profiles (
  profile_id, class_id, class_name,
  protocol_version, kernel_id,
  m, n, k, mix_rounds,
  stages_per_challenge,
  first_progress_deadline_ms, stage_deadline_ms, completion_deadline_ms,
  pool_target, pool_low_watermark_pct, pool_critical_watermark_pct,
  is_active
)
VALUES (
  'prod-gpu-medium-v2',
  202,                          -- class_id for production gpu-medium-v2
  'gpu-medium-v2',
  2,                            -- protocol_version 2 (production)
  'phase2a-kernel-v1',
  524288, 4096, 8, 2,           -- M, N, K, mix_rounds
  5,                            -- stages_per_challenge
  10000,                        -- first_progress_deadline_ms (10s)
  500,                          -- stage_deadline_ms (3.2x staging clean p99=157ms)
  10000,                        -- completion_deadline_ms (10s for 5 stages)
  20,                           -- pool_target
  50,                           -- pool_low_watermark_pct
  25,                           -- pool_critical_watermark_pct
  true                          -- is_active
)
ON CONFLICT (protocol_version, class_id) DO NOTHING;

COMMIT;

-- ============================================================
-- Verification
-- ============================================================
SELECT profile_id, class_id, class_name, protocol_version,
       m, n, k, mix_rounds, stages_per_challenge,
       first_progress_deadline_ms, stage_deadline_ms, completion_deadline_ms,
       pool_target, is_active
FROM compute_resource_class_profiles
WHERE protocol_version = 2
ORDER BY class_id;
