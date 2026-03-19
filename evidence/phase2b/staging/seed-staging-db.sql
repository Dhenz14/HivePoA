-- seed-staging-db.sql — Seed database for Phase 2B staging calibration
--
-- Run against the HivePoA PostgreSQL database BEFORE starting staging worker.
-- Idempotent: safe to run multiple times (ON CONFLICT DO NOTHING).
--
-- Usage:
--   psql -h localhost -U postgres -d hivepoa -f seed-staging-db.sql
--
-- What this creates:
--   1. Session for coordinator ("validator-police") to issue challenges
--   2. Session + agent key for staging worker to submit checkpoints
--   3. Compute node for the staging GPU worker
--   4. gpu-medium-v2 profile (corrected M=524288)
--   5. gpu-small-v2 profile (M=262144)

BEGIN;

-- ============================================================
-- 1. Coordinator session (for POST /api/compute/challenges/issue)
-- ============================================================
INSERT INTO user_sessions (token, username, role, expires_at)
VALUES (
  'staging-coordinator-token-2026',
  'validator-police',
  'admin',
  '2027-01-01T00:00:00Z'
)
ON CONFLICT (token) DO NOTHING;

-- ============================================================
-- 2. Worker session + agent key (for worker API calls)
-- ============================================================
INSERT INTO user_sessions (token, username, role, expires_at)
VALUES (
  'staging-worker-session-2026',
  'staging-gpu-worker',
  'user',
  '2027-01-01T00:00:00Z'
)
ON CONFLICT (token) DO NOTHING;

INSERT INTO agent_keys (id, api_key, hive_username, label)
VALUES (
  'staging-agent-key-id-001',
  'staging-gpu-worker-apikey-2026',
  'staging-gpu-worker',
  'Phase 2B Staging GPU Worker'
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 3. Compute node for the staging worker
-- ============================================================
INSERT INTO compute_nodes (
  id, node_instance_id, hive_username, api_key_id,
  status, gpu_model, gpu_vram_gb, cuda_version,
  supported_workloads, max_concurrent_jobs
)
VALUES (
  'staging-node-rtx4070ti-001',
  'staging-rtx4070ti-super-16gb',
  'staging-gpu-worker',
  'staging-agent-key-id-001',
  'online',
  'NVIDIA GeForce RTX 4070 Ti SUPER',
  16,
  '12.8',
  'gpu_poa_challenge',
  1
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 4. gpu-medium-v2 profile
--    M=524288 (corrected, see ERRATUM-001)
--    Working set: 8.59 GB
--    Positive control: RTX 4070 Ti SUPER → 118 ms/stage
--    Negative control: RTX 4070 SUPER → 198 ms/stage
--    Deadlines: generous for calibration (10x headroom)
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
  'staging-gpu-medium-v2',
  20,                           -- class_id for gpu-medium-v2
  'gpu-medium-v2',
  1,                            -- protocol_version (phase2a-kernel-v1)
  'phase2a-kernel-v1',
  524288, 4096, 8, 2,           -- M, N, K, mix_rounds (corrected)
  5,                            -- stages_per_challenge
  90000,                        -- first_progress_deadline_ms (90s — matches Phase 2A)
  30000,                        -- stage_deadline_ms (30s — 150x GPU speed, calibration headroom)
  300000,                       -- completion_deadline_ms (5 min total)
  25,                           -- pool_target (25 bundles)
  50,                           -- pool_low_watermark_pct
  25,                           -- pool_critical_watermark_pct
  true                          -- is_active
)
ON CONFLICT (protocol_version, class_id) DO NOTHING;

-- ============================================================
-- 5. gpu-small-v2 profile
--    M=262144 (corrected, see ERRATUM-001)
--    Working set: 4.29 GB
--    Deadlines: generous for calibration
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
  'staging-gpu-small-v2',
  10,                           -- class_id for gpu-small-v2
  'gpu-small-v2',
  1,                            -- protocol_version (phase2a-kernel-v1)
  'phase2a-kernel-v1',
  262144, 4096, 8, 1,           -- M, N, K, mix_rounds (corrected)
  5,                            -- stages_per_challenge
  90000,                        -- first_progress_deadline_ms (90s)
  30000,                        -- stage_deadline_ms (30s — calibration headroom)
  300000,                       -- completion_deadline_ms (5 min total)
  25,                           -- pool_target (25 bundles)
  50,                           -- pool_low_watermark_pct
  25,                           -- pool_critical_watermark_pct
  true                          -- is_active
)
ON CONFLICT (protocol_version, class_id) DO NOTHING;

COMMIT;

-- Verify
SELECT profile_id, class_name, m, n, k, mix_rounds, stages_per_challenge, is_active
FROM compute_resource_class_profiles
WHERE class_name IN ('gpu-medium-v2', 'gpu-small-v2');

SELECT id, hive_username, gpu_model, gpu_vram_gb, status
FROM compute_nodes
WHERE id = 'staging-node-rtx4070ti-001';
