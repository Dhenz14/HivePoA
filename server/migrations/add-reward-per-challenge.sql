-- Add reward_per_challenge column to storage_contracts
-- This stores the HBD amount paid per successful PoA proof for this contract
ALTER TABLE storage_contracts
  ADD COLUMN IF NOT EXISTS reward_per_challenge TEXT NOT NULL DEFAULT '0.005';
