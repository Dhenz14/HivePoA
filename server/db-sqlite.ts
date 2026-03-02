/**
 * SQLite database connection for embedded desktop agent mode.
 *
 * Activated when SQLITE_DB_PATH is set (instead of DATABASE_URL for PostgreSQL).
 * Uses better-sqlite3 for synchronous, zero-config embedded database.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../shared/schema-sqlite";

let _sqliteDb: ReturnType<typeof drizzle> | null = null;
let _rawDb: InstanceType<typeof Database> | null = null;

export function initSQLite(dbPath: string) {
  if (_sqliteDb) return _sqliteDb;

  _rawDb = new Database(dbPath);

  // Performance pragmas for desktop use
  _rawDb.pragma("journal_mode = WAL");
  _rawDb.pragma("synchronous = NORMAL");
  _rawDb.pragma("foreign_keys = ON");
  _rawDb.pragma("busy_timeout = 5000");
  _rawDb.pragma("cache_size = -64000"); // 64MB

  _sqliteDb = drizzle(_rawDb, { schema });
  return _sqliteDb;
}

export function getSQLiteDb() {
  if (!_sqliteDb) throw new Error("SQLite not initialized — call initSQLite() first");
  return _sqliteDb;
}

export function getRawSQLiteDb() {
  if (!_rawDb) throw new Error("SQLite not initialized — call initSQLite() first");
  return _rawDb;
}

export function closeSQLite() {
  if (_rawDb) {
    _rawDb.close();
    _rawDb = null;
    _sqliteDb = null;
  }
}

/**
 * Create all tables from schema. Idempotent (IF NOT EXISTS).
 * Called on first launch or after schema changes.
 */
export function createSQLiteTables(dbPath: string) {
  const db = initSQLite(dbPath);
  const raw = getRawSQLiteDb();

  // Create all 42 tables using raw SQL (Drizzle doesn't have a built-in createTable for SQLite)
  // We use CREATE TABLE IF NOT EXISTS so this is safe to run on every startup.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS storage_nodes (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL UNIQUE,
      hive_username TEXT NOT NULL,
      endpoint TEXT,
      reputation INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'active',
      total_proofs INTEGER NOT NULL DEFAULT 0,
      failed_proofs INTEGER NOT NULL DEFAULT 0,
      consecutive_fails INTEGER NOT NULL DEFAULT 0,
      total_earned_hbd REAL NOT NULL DEFAULT 0,
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      cid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      size TEXT NOT NULL,
      uploader_username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'syncing',
      replication_count INTEGER NOT NULL DEFAULT 0,
      confidence INTEGER NOT NULL DEFAULT 0,
      poa_enabled INTEGER NOT NULL DEFAULT 1,
      total_chunks INTEGER,
      uploaded_chunks INTEGER DEFAULT 0,
      upload_session_id TEXT,
      upload_expires_at TEXT,
      ssdeep_hash TEXT,
      encrypted INTEGER NOT NULL DEFAULT 0,
      encryption_nonce TEXT,
      earned_hbd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS storage_assignments (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id),
      node_id TEXT NOT NULL REFERENCES storage_nodes(id),
      proof_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      last_proof_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS validators (
      id TEXT PRIMARY KEY,
      hive_username TEXT NOT NULL UNIQUE,
      hive_rank INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'online',
      peer_count INTEGER NOT NULL DEFAULT 0,
      performance INTEGER NOT NULL DEFAULT 50,
      job_allocation INTEGER NOT NULL DEFAULT 0,
      payout_rate REAL NOT NULL DEFAULT 1.0,
      version TEXT NOT NULL DEFAULT 'v0.1.0',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS poa_challenges (
      id TEXT PRIMARY KEY,
      validator_id TEXT NOT NULL REFERENCES validators(id),
      node_id TEXT NOT NULL REFERENCES storage_nodes(id),
      file_id TEXT NOT NULL REFERENCES files(id),
      challenge_data TEXT NOT NULL,
      response TEXT,
      result TEXT,
      latency_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hive_transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      from_user TEXT NOT NULL,
      to_user TEXT,
      payload TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS validator_blacklists (
      id TEXT PRIMARY KEY,
      validator_id TEXT NOT NULL REFERENCES validators(id),
      node_id TEXT NOT NULL REFERENCES storage_nodes(id),
      reason TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cdn_nodes (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL UNIQUE,
      hive_username TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      geo_region TEXT NOT NULL DEFAULT 'unknown',
      geo_country TEXT,
      geo_continent TEXT,
      capacity TEXT NOT NULL DEFAULT '0',
      throughput_min INTEGER DEFAULT 0,
      throughput_max INTEGER DEFAULT 0,
      health_score TEXT NOT NULL DEFAULT 'WW',
      raw_z_score REAL DEFAULT 0,
      geo_z_score REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cdn_metrics (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES cdn_nodes(id),
      latency_ms INTEGER NOT NULL,
      success_rate REAL NOT NULL DEFAULT 1.0,
      request_count INTEGER NOT NULL DEFAULT 1,
      source_region TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS file_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id),
      chunk_index INTEGER NOT NULL,
      chunk_size INTEGER NOT NULL,
      checksum TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS storage_contracts (
      id TEXT PRIMARY KEY,
      file_id TEXT REFERENCES files(id),
      file_cid TEXT NOT NULL,
      uploader_username TEXT NOT NULL,
      requested_replication INTEGER NOT NULL DEFAULT 3,
      actual_replication INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      hbd_budget TEXT NOT NULL DEFAULT '0',
      hbd_spent TEXT NOT NULL DEFAULT '0',
      reward_per_challenge TEXT NOT NULL DEFAULT '0.005',
      validator_approval_at TEXT,
      starts_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contract_events (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES storage_contracts(id),
      event_type TEXT NOT NULL,
      payload TEXT,
      triggered_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS encoding_jobs (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      permlink TEXT NOT NULL,
      input_cid TEXT NOT NULL,
      output_cid TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      encoding_mode TEXT NOT NULL DEFAULT 'auto',
      encoder_type TEXT,
      encoder_node_id TEXT,
      encoder_peer_id TEXT,
      is_short INTEGER NOT NULL DEFAULT 0,
      qualities_encoded TEXT DEFAULT '',
      video_url TEXT,
      webhook_url TEXT,
      webhook_delivered INTEGER NOT NULL DEFAULT 0,
      hbd_cost TEXT DEFAULT '0',
      error_message TEXT,
      original_filename TEXT,
      input_size_bytes INTEGER,
      output_size_bytes INTEGER,
      processing_time_sec INTEGER,
      assigned_at TEXT,
      assigned_encoder_id TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      next_retry_at TEXT,
      current_stage TEXT,
      stage_progress INTEGER DEFAULT 0,
      job_signature TEXT,
      webhook_secret TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transcode_jobs (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id),
      input_cid TEXT NOT NULL,
      output_cid TEXT,
      preset TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      encoder_node_id TEXT REFERENCES encoder_nodes(id),
      hbd_cost TEXT DEFAULT '0',
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS encoder_nodes (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL UNIQUE,
      hive_username TEXT NOT NULL,
      endpoint TEXT,
      encoder_type TEXT NOT NULL DEFAULT 'community',
      presets_supported TEXT NOT NULL DEFAULT 'hls,mp4-720p',
      base_price_hbd TEXT NOT NULL DEFAULT '0.01',
      price_1080p TEXT NOT NULL DEFAULT '0.02',
      price_720p TEXT NOT NULL DEFAULT '0.01',
      price_480p TEXT NOT NULL DEFAULT '0.005',
      price_all_qualities TEXT NOT NULL DEFAULT '0.03',
      min_offer_hbd TEXT NOT NULL DEFAULT '0.005',
      availability TEXT NOT NULL DEFAULT 'available',
      jobs_completed INTEGER NOT NULL DEFAULT 0,
      jobs_in_progress INTEGER NOT NULL DEFAULT 0,
      avg_processing_time INTEGER DEFAULT 0,
      hardware_acceleration TEXT,
      rating REAL DEFAULT 5.0,
      reputation_score INTEGER NOT NULL DEFAULT 100,
      success_rate REAL NOT NULL DEFAULT 100.0,
      status TEXT NOT NULL DEFAULT 'active',
      last_heartbeat TEXT DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS encoding_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      video_bitrate TEXT NOT NULL,
      audio_bitrate TEXT NOT NULL DEFAULT '128k',
      video_codec TEXT NOT NULL DEFAULT 'h264',
      audio_codec TEXT NOT NULL DEFAULT 'aac',
      profile TEXT NOT NULL DEFAULT 'high',
      level TEXT NOT NULL DEFAULT '4.1',
      preset TEXT NOT NULL DEFAULT 'medium',
      is_default INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_encoding_settings (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      preferred_mode TEXT NOT NULL DEFAULT 'auto',
      desktop_agent_enabled INTEGER NOT NULL DEFAULT 0,
      desktop_agent_endpoint TEXT,
      browser_encoding_enabled INTEGER NOT NULL DEFAULT 1,
      max_community_hbd TEXT DEFAULT '1.00',
      default_is_short INTEGER NOT NULL DEFAULT 0,
      webhook_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS encoder_capabilities (
      id TEXT PRIMARY KEY,
      encoder_node_id TEXT NOT NULL,
      codec TEXT NOT NULL,
      max_resolution TEXT NOT NULL,
      hw_accel_type TEXT,
      estimated_speed REAL,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS encoding_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      previous_status TEXT,
      new_status TEXT,
      encoder_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS encoding_job_offers (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      input_cid TEXT NOT NULL,
      qualities_requested TEXT NOT NULL,
      video_duration_sec INTEGER NOT NULL,
      offered_hbd TEXT NOT NULL,
      market_price_hbd TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      accepted_encoder_id TEXT,
      accepted_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocklist_entries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_owner_id TEXT,
      target_type TEXT NOT NULL,
      target_value TEXT NOT NULL,
      reason TEXT,
      severity TEXT NOT NULL DEFAULT 'moderate',
      active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_blocklists (
      id TEXT PRIMARY KEY,
      platform_id TEXT NOT NULL,
      platform_name TEXT NOT NULL,
      policy_url TEXT,
      enforce_level TEXT NOT NULL DEFAULT 'warn',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'content',
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS file_tags (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id),
      tag_id TEXT NOT NULL REFERENCES tags(id),
      votes_up INTEGER NOT NULL DEFAULT 0,
      votes_down INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tag_votes (
      id TEXT PRIMARY KEY,
      file_tag_id TEXT NOT NULL REFERENCES file_tags(id),
      voter_username TEXT NOT NULL,
      vote_type TEXT NOT NULL,
      voter_reputation INTEGER DEFAULT 50,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_keys (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      key_type TEXT NOT NULL,
      key_value TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'AES-GCM',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_node_settings (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      auto_pin_enabled INTEGER NOT NULL DEFAULT 0,
      auto_pin_mode TEXT NOT NULL DEFAULT 'off',
      auto_pin_daily_limit INTEGER DEFAULT 10,
      auto_pin_today_count INTEGER NOT NULL DEFAULT 0,
      auto_pin_last_reset TEXT DEFAULT (datetime('now')),
      auto_pin_threshold INTEGER DEFAULT 60,
      max_auto_pin_size TEXT DEFAULT '104857600',
      encrypt_by_default INTEGER NOT NULL DEFAULT 0,
      download_mode TEXT NOT NULL DEFAULT 'off',
      download_quota INTEGER DEFAULT 10,
      downloaded_today INTEGER NOT NULL DEFAULT 0,
      download_last_reset TEXT DEFAULT (datetime('now')),
      download_in_progress INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS view_events (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id),
      viewer_username TEXT NOT NULL,
      view_duration_ms INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      auto_pin_triggered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS beneficiary_allocations (
      id TEXT PRIMARY KEY,
      from_username TEXT NOT NULL,
      to_node_id TEXT NOT NULL REFERENCES storage_nodes(id),
      percentage REAL NOT NULL,
      hbd_allocated TEXT NOT NULL DEFAULT '0',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payout_history (
      id TEXT PRIMARY KEY,
      contract_id TEXT REFERENCES storage_contracts(id),
      recipient_username TEXT NOT NULL,
      recipient_node_id TEXT REFERENCES storage_nodes(id),
      hbd_amount TEXT NOT NULL,
      payout_type TEXT NOT NULL,
      tx_hash TEXT,
      broadcast_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wallet_deposits (
      id TEXT PRIMARY KEY,
      from_username TEXT NOT NULL,
      hbd_amount TEXT NOT NULL,
      memo TEXT,
      tx_hash TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL DEFAULT 'storage',
      processed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payout_reports (
      id TEXT PRIMARY KEY,
      validator_username TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      total_hbd TEXT NOT NULL,
      recipient_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      executed_at TEXT,
      executed_tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payout_line_items (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES payout_reports(id),
      recipient_username TEXT NOT NULL,
      hbd_amount TEXT NOT NULL,
      proof_count INTEGER NOT NULL,
      success_rate REAL NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      validator_opted_in INTEGER,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_keys (
      id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL UNIQUE,
      hive_username TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS file_refs (
      id TEXT PRIMARY KEY,
      cid TEXT NOT NULL UNIQUE,
      block_cids TEXT NOT NULL,
      block_count INTEGER NOT NULL,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS p2p_sessions (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL,
      video_cid TEXT NOT NULL,
      room_id TEXT NOT NULL,
      hive_username TEXT,
      is_desktop_agent INTEGER NOT NULL DEFAULT 0,
      ip_address TEXT,
      user_agent TEXT,
      geo_region TEXT,
      geo_country TEXT,
      bytes_uploaded INTEGER NOT NULL DEFAULT 0,
      bytes_downloaded INTEGER NOT NULL DEFAULT 0,
      segments_shared INTEGER NOT NULL DEFAULT 0,
      peers_connected INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
      disconnected_at TEXT
    );

    CREATE TABLE IF NOT EXISTS p2p_contributions (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL,
      hive_username TEXT,
      video_cid TEXT NOT NULL,
      bytes_shared INTEGER NOT NULL DEFAULT 0,
      segments_shared INTEGER NOT NULL DEFAULT 0,
      session_duration_sec INTEGER NOT NULL DEFAULT 0,
      p2p_ratio REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS p2p_rooms (
      id TEXT PRIMARY KEY,
      video_cid TEXT NOT NULL UNIQUE,
      active_peers INTEGER NOT NULL DEFAULT 0,
      total_bytes_shared INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS p2p_network_stats (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      active_peers INTEGER NOT NULL DEFAULT 0,
      active_rooms INTEGER NOT NULL DEFAULT 0,
      total_bytes_shared INTEGER NOT NULL DEFAULT 0,
      avg_p2p_ratio REAL NOT NULL DEFAULT 0,
      bandwidth_saved_bytes INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS web_of_trust (
      id TEXT PRIMARY KEY,
      sponsor_username TEXT NOT NULL UNIQUE,
      vouched_username TEXT NOT NULL UNIQUE,
      sponsor_rank_at_vouch INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      revoked_at TEXT,
      revoke_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}
