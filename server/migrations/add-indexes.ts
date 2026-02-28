import { pool } from "../db";
import { logDB } from "../logger";

/**
 * Creates performance-critical indexes using IF NOT EXISTS.
 * Safe to run multiple times (idempotent).
 * Note: PostgreSQL 12 does not support CONCURRENTLY inside transactions,
 * so we run each index creation as a separate statement.
 */
export async function addIndexes(): Promise<void> {
  const indexes = [
    // PoA Challenges — the most queried table
    `CREATE INDEX IF NOT EXISTS idx_poa_challenges_created_at ON poa_challenges (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_poa_challenges_validator_id ON poa_challenges (validator_id)`,
    `CREATE INDEX IF NOT EXISTS idx_poa_challenges_node_id ON poa_challenges (node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_poa_challenges_file_id ON poa_challenges (file_id)`,
    `CREATE INDEX IF NOT EXISTS idx_poa_challenges_result ON poa_challenges (result)`,
    `CREATE INDEX IF NOT EXISTS idx_poa_challenges_node_created ON poa_challenges (node_id, created_at DESC)`,

    // Hive Transactions
    `CREATE INDEX IF NOT EXISTS idx_hive_transactions_created_at ON hive_transactions (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_hive_transactions_type ON hive_transactions (type)`,
    `CREATE INDEX IF NOT EXISTS idx_hive_transactions_to_user ON hive_transactions (to_user)`,

    // Storage Assignments
    `CREATE INDEX IF NOT EXISTS idx_storage_assignments_file_id ON storage_assignments (file_id)`,
    `CREATE INDEX IF NOT EXISTS idx_storage_assignments_node_id ON storage_assignments (node_id)`,

    // View Events
    `CREATE INDEX IF NOT EXISTS idx_view_events_file_id ON view_events (file_id)`,
    `CREATE INDEX IF NOT EXISTS idx_view_events_viewer ON view_events (viewer_username)`,

    // Blocklist Entries
    `CREATE INDEX IF NOT EXISTS idx_blocklist_target ON blocklist_entries (target_type, target_value)`,
    `CREATE INDEX IF NOT EXISTS idx_blocklist_scope_active ON blocklist_entries (scope, active)`,

    // CDN Metrics
    `CREATE INDEX IF NOT EXISTS idx_cdn_metrics_node_id ON cdn_metrics (node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_cdn_metrics_created_at ON cdn_metrics (created_at DESC)`,

    // Validator Blacklists
    `CREATE INDEX IF NOT EXISTS idx_validator_blacklists_validator_active ON validator_blacklists (validator_id, active)`,
    `CREATE INDEX IF NOT EXISTS idx_validator_blacklists_node_id ON validator_blacklists (node_id)`,

    // Storage Nodes
    `CREATE INDEX IF NOT EXISTS idx_storage_nodes_hive_username ON storage_nodes (hive_username)`,
    `CREATE INDEX IF NOT EXISTS idx_storage_nodes_status ON storage_nodes (status)`,
    `CREATE INDEX IF NOT EXISTS idx_storage_nodes_reputation ON storage_nodes (reputation DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_storage_nodes_last_seen ON storage_nodes (last_seen DESC)`,

    // Encoding Jobs
    `CREATE INDEX IF NOT EXISTS idx_encoding_jobs_status ON encoding_jobs (status)`,
    `CREATE INDEX IF NOT EXISTS idx_encoding_jobs_owner ON encoding_jobs (owner)`,
    `CREATE INDEX IF NOT EXISTS idx_encoding_jobs_created_at ON encoding_jobs (created_at DESC)`,

    // Files
    `CREATE INDEX IF NOT EXISTS idx_files_uploader ON files (uploader_username)`,
    `CREATE INDEX IF NOT EXISTS idx_files_status ON files (status)`,
    `CREATE INDEX IF NOT EXISTS idx_files_created_at ON files (created_at DESC)`,

    // Contract Events (for deleteFile cascade)
    `CREATE INDEX IF NOT EXISTS idx_contract_events_contract_id ON contract_events (contract_id)`,

    // Storage Contracts
    `CREATE INDEX IF NOT EXISTS idx_storage_contracts_file_id ON storage_contracts (file_id)`,
    `CREATE INDEX IF NOT EXISTS idx_storage_contracts_status ON storage_contracts (status)`,

    // Encoding Job Offers
    `CREATE INDEX IF NOT EXISTS idx_encoding_job_offers_status ON encoding_job_offers (status)`,
    `CREATE INDEX IF NOT EXISTS idx_encoding_job_offers_owner ON encoding_job_offers (owner)`,

    // File Tags
    `CREATE INDEX IF NOT EXISTS idx_file_tags_file_id ON file_tags (file_id)`,

    // Tag Votes
    `CREATE INDEX IF NOT EXISTS idx_tag_votes_file_tag_id ON tag_votes (file_tag_id)`,

    // Payout
    `CREATE INDEX IF NOT EXISTS idx_payout_history_recipient ON payout_history (recipient_username)`,
    `CREATE INDEX IF NOT EXISTS idx_payout_line_items_report ON payout_line_items (report_id)`,
  ];

  const client = await pool.connect();
  try {
    for (const sql of indexes) {
      await client.query(sql);
    }
    logDB.info(`[migrations] Created ${indexes.length} indexes`);
  } finally {
    client.release();
  }
}
