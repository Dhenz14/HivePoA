-- v1.1: Add sizeBytes to files, storageTierId to storage_contracts
-- Run after drizzle-kit push to backfill existing data

-- Add columns (drizzle-kit push handles this, but included for manual runs)
ALTER TABLE files ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE storage_contracts ADD COLUMN IF NOT EXISTS storage_tier_id TEXT;

-- Backfill sizeBytes from formatted size strings
-- Handles "5.2 MB", "512.5 KB", "1.3 GB" formats
UPDATE files
SET size_bytes = CASE
  WHEN size LIKE '% GB' THEN CAST(CAST(SUBSTRING(size FROM '^([0-9.]+)') AS DECIMAL) * 1073741824 AS BIGINT)
  WHEN size LIKE '% MB' THEN CAST(CAST(SUBSTRING(size FROM '^([0-9.]+)') AS DECIMAL) * 1048576 AS BIGINT)
  WHEN size LIKE '% KB' THEN CAST(CAST(SUBSTRING(size FROM '^([0-9.]+)') AS DECIMAL) * 1024 AS BIGINT)
  ELSE 0
END
WHERE size_bytes = 0 AND size IS NOT NULL AND size != '';
