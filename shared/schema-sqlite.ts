/**
 * SQLite schema — mirrors shared/schema.ts (PostgreSQL) for embedded desktop agent use.
 *
 * Key differences from the PG schema:
 *   - sqliteTable instead of pgTable
 *   - text() replaces varchar() and timestamp() (SQLite has no native types for these)
 *   - integer("x", { mode: "boolean" }) replaces boolean()
 *   - No gen_random_uuid() — UUIDs generated in application code
 *   - Timestamps stored as ISO 8601 text, e.g. "2026-03-02T21:33:11.000Z"
 *
 * Types are NOT re-exported here — import them from shared/schema.ts to keep
 * a single source of truth for TypeScript interfaces across both dialects.
 */

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// ============================================================
// PHASE 0: Core Tables
// ============================================================

export const storageNodes = sqliteTable("storage_nodes", {
  id: text("id").primaryKey(),
  peerId: text("peer_id").notNull().unique(),
  hiveUsername: text("hive_username").notNull(),
  endpoint: text("endpoint"),
  reputation: integer("reputation").notNull().default(50),
  status: text("status").notNull().default("active"),
  totalProofs: integer("total_proofs").notNull().default(0),
  failedProofs: integer("failed_proofs").notNull().default(0),
  consecutiveFails: integer("consecutive_fails").notNull().default(0),
  totalEarnedHbd: real("total_earned_hbd").notNull().default(0),
  lastSeen: text("last_seen").notNull().default(sql`(datetime('now'))`),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  cid: text("cid").notNull().unique(),
  name: text("name").notNull(),
  size: text("size").notNull(),
  uploaderUsername: text("uploader_username").notNull(),
  status: text("status").notNull().default("syncing"),
  replicationCount: integer("replication_count").notNull().default(0),
  confidence: integer("confidence").notNull().default(0),
  poaEnabled: integer("poa_enabled", { mode: "boolean" }).notNull().default(true),
  totalChunks: integer("total_chunks"),
  uploadedChunks: integer("uploaded_chunks").default(0),
  uploadSessionId: text("upload_session_id"),
  uploadExpiresAt: text("upload_expires_at"),
  ssdeepHash: text("ssdeep_hash"),
  encrypted: integer("encrypted", { mode: "boolean" }).notNull().default(false),
  encryptionNonce: text("encryption_nonce"),
  earnedHbd: real("earned_hbd").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const storageAssignments = sqliteTable("storage_assignments", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id),
  nodeId: text("node_id").notNull().references(() => storageNodes.id),
  proofCount: integer("proof_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  lastProofAt: text("last_proof_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const validators = sqliteTable("validators", {
  id: text("id").primaryKey(),
  hiveUsername: text("hive_username").notNull().unique(),
  hiveRank: integer("hive_rank").notNull(),
  status: text("status").notNull().default("online"),
  peerCount: integer("peer_count").notNull().default(0),
  performance: integer("performance").notNull().default(50),
  jobAllocation: integer("job_allocation").notNull().default(0),
  payoutRate: real("payout_rate").notNull().default(1.0),
  version: text("version").notNull().default("v0.1.0"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const poaChallenges = sqliteTable("poa_challenges", {
  id: text("id").primaryKey(),
  validatorId: text("validator_id").notNull().references(() => validators.id),
  nodeId: text("node_id").notNull().references(() => storageNodes.id),
  fileId: text("file_id").notNull().references(() => files.id),
  challengeData: text("challenge_data").notNull(),
  response: text("response"),
  result: text("result"),
  latencyMs: integer("latency_ms"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const hiveTransactions = sqliteTable("hive_transactions", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  fromUser: text("from_user").notNull(),
  toUser: text("to_user"),
  payload: text("payload").notNull(),
  blockNumber: integer("block_number").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const validatorBlacklists = sqliteTable("validator_blacklists", {
  id: text("id").primaryKey(),
  validatorId: text("validator_id").notNull().references(() => validators.id),
  nodeId: text("node_id").notNull().references(() => storageNodes.id),
  reason: text("reason").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ============================================================
// PHASE 1: CDN & Storage System
// ============================================================

export const cdnNodes = sqliteTable("cdn_nodes", {
  id: text("id").primaryKey(),
  peerId: text("peer_id").notNull().unique(),
  hiveUsername: text("hive_username").notNull(),
  endpoint: text("endpoint").notNull(),
  geoRegion: text("geo_region").notNull().default("unknown"),
  geoCountry: text("geo_country"),
  geoContinent: text("geo_continent"),
  capacity: text("capacity").notNull().default("0"),
  throughputMin: integer("throughput_min").default(0),
  throughputMax: integer("throughput_max").default(0),
  healthScore: text("health_score").notNull().default("WW"),
  rawZScore: real("raw_z_score").default(0),
  geoZScore: real("geo_z_score").default(0),
  status: text("status").notNull().default("active"),
  lastHeartbeat: text("last_heartbeat").notNull().default(sql`(datetime('now'))`),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const cdnMetrics = sqliteTable("cdn_metrics", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull().references(() => cdnNodes.id),
  latencyMs: integer("latency_ms").notNull(),
  successRate: real("success_rate").notNull().default(1.0),
  requestCount: integer("request_count").notNull().default(1),
  sourceRegion: text("source_region"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const fileChunks = sqliteTable("file_chunks", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id),
  chunkIndex: integer("chunk_index").notNull(),
  chunkSize: integer("chunk_size").notNull(),
  checksum: text("checksum"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const storageContracts = sqliteTable("storage_contracts", {
  id: text("id").primaryKey(),
  fileId: text("file_id").references(() => files.id),
  fileCid: text("file_cid").notNull(),
  uploaderUsername: text("uploader_username").notNull(),
  requestedReplication: integer("requested_replication").notNull().default(3),
  actualReplication: integer("actual_replication").notNull().default(0),
  status: text("status").notNull().default("pending"),
  hbdBudget: text("hbd_budget").notNull().default("0"),
  hbdSpent: text("hbd_spent").notNull().default("0"),
  rewardPerChallenge: text("reward_per_challenge").notNull().default("0.005"),
  validatorApprovalAt: text("validator_approval_at"),
  startsAt: text("starts_at").notNull().default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const contractEvents = sqliteTable("contract_events", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").notNull().references(() => storageContracts.id),
  eventType: text("event_type").notNull(),
  payload: text("payload"),
  triggeredBy: text("triggered_by"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ============================================================
// PHASE 2: Video Transcoding & Hybrid Encoding System
// ============================================================

export const encodingJobs = sqliteTable("encoding_jobs", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  permlink: text("permlink").notNull(),
  inputCid: text("input_cid").notNull(),
  outputCid: text("output_cid"),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  encodingMode: text("encoding_mode").notNull().default("auto"),
  encoderType: text("encoder_type"),
  encoderNodeId: text("encoder_node_id"),
  encoderPeerId: text("encoder_peer_id"),
  isShort: integer("is_short", { mode: "boolean" }).notNull().default(false),
  qualitiesEncoded: text("qualities_encoded").default(""),
  videoUrl: text("video_url"),
  webhookUrl: text("webhook_url"),
  webhookDelivered: integer("webhook_delivered", { mode: "boolean" }).notNull().default(false),
  hbdCost: text("hbd_cost").default("0"),
  errorMessage: text("error_message"),
  originalFilename: text("original_filename"),
  inputSizeBytes: integer("input_size_bytes"),
  outputSizeBytes: integer("output_size_bytes"),
  processingTimeSec: integer("processing_time_sec"),
  assignedAt: text("assigned_at"),
  assignedEncoderId: text("assigned_encoder_id"),
  leaseExpiresAt: text("lease_expires_at"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  lastError: text("last_error"),
  nextRetryAt: text("next_retry_at"),
  currentStage: text("current_stage"),
  stageProgress: integer("stage_progress").default(0),
  jobSignature: text("job_signature"),
  webhookSecret: text("webhook_secret"),
  priority: integer("priority").notNull().default(0),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const transcodeJobs = sqliteTable("transcode_jobs", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id),
  inputCid: text("input_cid").notNull(),
  outputCid: text("output_cid"),
  preset: text("preset").notNull(),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  encoderNodeId: text("encoder_node_id").references(() => encoderNodes.id),
  hbdCost: text("hbd_cost").default("0"),
  errorMessage: text("error_message"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const encoderNodes = sqliteTable("encoder_nodes", {
  id: text("id").primaryKey(),
  peerId: text("peer_id").notNull().unique(),
  hiveUsername: text("hive_username").notNull(),
  endpoint: text("endpoint"),
  encoderType: text("encoder_type").notNull().default("community"),
  presetsSupported: text("presets_supported").notNull().default("hls,mp4-720p"),
  basePriceHbd: text("base_price_hbd").notNull().default("0.01"),
  price1080p: text("price_1080p").notNull().default("0.02"),
  price720p: text("price_720p").notNull().default("0.01"),
  price480p: text("price_480p").notNull().default("0.005"),
  priceAllQualities: text("price_all_qualities").notNull().default("0.03"),
  minOfferHbd: text("min_offer_hbd").notNull().default("0.005"),
  availability: text("availability").notNull().default("available"),
  jobsCompleted: integer("jobs_completed").notNull().default(0),
  jobsInProgress: integer("jobs_in_progress").notNull().default(0),
  avgProcessingTime: integer("avg_processing_time").default(0),
  hardwareAcceleration: text("hardware_acceleration"),
  rating: real("rating").default(5.0),
  reputationScore: integer("reputation_score").notNull().default(100),
  successRate: real("success_rate").notNull().default(100.0),
  status: text("status").notNull().default("active"),
  lastHeartbeat: text("last_heartbeat").default(sql`(datetime('now'))`),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const encodingProfiles = sqliteTable("encoding_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  videoBitrate: text("video_bitrate").notNull(),
  audioBitrate: text("audio_bitrate").notNull().default("128k"),
  videoCodec: text("video_codec").notNull().default("h264"),
  audioCodec: text("audio_codec").notNull().default("aac"),
  profile: text("profile").notNull().default("high"),
  level: text("level").notNull().default("4.1"),
  preset: text("preset").notNull().default("medium"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const userEncodingSettings = sqliteTable("user_encoding_settings", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  preferredMode: text("preferred_mode").notNull().default("auto"),
  desktopAgentEnabled: integer("desktop_agent_enabled", { mode: "boolean" }).notNull().default(false),
  desktopAgentEndpoint: text("desktop_agent_endpoint"),
  browserEncodingEnabled: integer("browser_encoding_enabled", { mode: "boolean" }).notNull().default(true),
  maxCommunityHbd: text("max_community_hbd").default("1.00"),
  defaultIsShort: integer("default_is_short", { mode: "boolean" }).notNull().default(false),
  webhookUrl: text("webhook_url"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const encoderCapabilities = sqliteTable("encoder_capabilities", {
  id: text("id").primaryKey(),
  encoderNodeId: text("encoder_node_id").notNull(),
  codec: text("codec").notNull(),
  maxResolution: text("max_resolution").notNull(),
  hwAccelType: text("hw_accel_type"),
  estimatedSpeed: real("estimated_speed"),
  verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const encodingJobEvents = sqliteTable("encoding_job_events", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  eventType: text("event_type").notNull(),
  previousStatus: text("previous_status"),
  newStatus: text("new_status"),
  encoderId: text("encoder_id"),
  details: text("details"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const encodingJobOffers = sqliteTable("encoding_job_offers", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  owner: text("owner").notNull(),
  inputCid: text("input_cid").notNull(),
  qualitiesRequested: text("qualities_requested").notNull(),
  videoDurationSec: integer("video_duration_sec").notNull(),
  offeredHbd: text("offered_hbd").notNull(),
  marketPriceHbd: text("market_price_hbd").notNull(),
  status: text("status").notNull().default("pending"),
  acceptedEncoderId: text("accepted_encoder_id"),
  acceptedAt: text("accepted_at"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ============================================================
// PHASE 3: Multi-Tier Blocklist System
// ============================================================

export const blocklistEntries = sqliteTable("blocklist_entries", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  scopeOwnerId: text("scope_owner_id"),
  targetType: text("target_type").notNull(),
  targetValue: text("target_value").notNull(),
  reason: text("reason"),
  severity: text("severity").notNull().default("moderate"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const platformBlocklists = sqliteTable("platform_blocklists", {
  id: text("id").primaryKey(),
  platformId: text("platform_id").notNull(),
  platformName: text("platform_name").notNull(),
  policyUrl: text("policy_url"),
  enforceLevel: text("enforce_level").notNull().default("warn"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  label: text("label").notNull().unique(),
  category: text("category").notNull().default("content"),
  description: text("description"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const fileTags = sqliteTable("file_tags", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id),
  tagId: text("tag_id").notNull().references(() => tags.id),
  votesUp: integer("votes_up").notNull().default(0),
  votesDown: integer("votes_down").notNull().default(0),
  confidence: real("confidence").notNull().default(0),
  addedBy: text("added_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const tagVotes = sqliteTable("tag_votes", {
  id: text("id").primaryKey(),
  fileTagId: text("file_tag_id").notNull().references(() => fileTags.id),
  voterUsername: text("voter_username").notNull(),
  voteType: text("vote_type").notNull(),
  voterReputation: integer("voter_reputation").default(50),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ============================================================
// PHASE 4: Desktop Parity Features
// ============================================================

export const userKeys = sqliteTable("user_keys", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  keyType: text("key_type").notNull(),
  keyValue: text("key_value").notNull(),
  algorithm: text("algorithm").notNull().default("AES-GCM"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const userNodeSettings = sqliteTable("user_node_settings", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  autoPinEnabled: integer("auto_pin_enabled", { mode: "boolean" }).notNull().default(false),
  autoPinMode: text("auto_pin_mode").notNull().default("off"),
  autoPinDailyLimit: integer("auto_pin_daily_limit").default(10),
  autoPinTodayCount: integer("auto_pin_today_count").notNull().default(0),
  autoPinLastReset: text("auto_pin_last_reset").default(sql`(datetime('now'))`),
  autoPinThreshold: integer("auto_pin_threshold").default(60),
  maxAutoPinSize: text("max_auto_pin_size").default("104857600"),
  encryptByDefault: integer("encrypt_by_default", { mode: "boolean" }).notNull().default(false),
  downloadMode: text("download_mode").notNull().default("off"),
  downloadQuota: integer("download_quota").default(10),
  downloadedToday: integer("downloaded_today").notNull().default(0),
  downloadLastReset: text("download_last_reset").default(sql`(datetime('now'))`),
  downloadInProgress: integer("download_in_progress", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const viewEvents = sqliteTable("view_events", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id),
  viewerUsername: text("viewer_username").notNull(),
  viewDurationMs: integer("view_duration_ms"),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  autoPinTriggered: integer("auto_pin_triggered", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const beneficiaryAllocations = sqliteTable("beneficiary_allocations", {
  id: text("id").primaryKey(),
  fromUsername: text("from_username").notNull(),
  toNodeId: text("to_node_id").notNull().references(() => storageNodes.id),
  percentage: real("percentage").notNull(),
  hbdAllocated: text("hbd_allocated").notNull().default("0"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const payoutHistory = sqliteTable("payout_history", {
  id: text("id").primaryKey(),
  contractId: text("contract_id").references(() => storageContracts.id),
  recipientUsername: text("recipient_username").notNull(),
  recipientNodeId: text("recipient_node_id").references(() => storageNodes.id),
  hbdAmount: text("hbd_amount").notNull(),
  payoutType: text("payout_type").notNull(),
  txHash: text("tx_hash"),
  broadcastStatus: text("broadcast_status"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ============================================================
// PHASE 5: Payout System
// ============================================================

export const walletDeposits = sqliteTable("wallet_deposits", {
  id: text("id").primaryKey(),
  fromUsername: text("from_username").notNull(),
  hbdAmount: text("hbd_amount").notNull(),
  memo: text("memo"),
  txHash: text("tx_hash").notNull().unique(),
  purpose: text("purpose").notNull().default("storage"),
  processed: integer("processed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const payoutReports = sqliteTable("payout_reports", {
  id: text("id").primaryKey(),
  validatorUsername: text("validator_username").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  totalHbd: text("total_hbd").notNull(),
  recipientCount: integer("recipient_count").notNull(),
  status: text("status").notNull().default("pending"),
  executedAt: text("executed_at"),
  executedTxHash: text("executed_tx_hash"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const payoutLineItems = sqliteTable("payout_line_items", {
  id: text("id").primaryKey(),
  reportId: text("report_id").notNull().references(() => payoutReports.id),
  recipientUsername: text("recipient_username").notNull(),
  hbdAmount: text("hbd_amount").notNull(),
  proofCount: integer("proof_count").notNull(),
  successRate: real("success_rate").notNull(),
  paid: integer("paid", { mode: "boolean" }).notNull().default(false),
  txHash: text("tx_hash"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ============================================================
// Validator Sessions
// ============================================================

export const userSessions = sqliteTable("user_sessions", {
  token: text("token").primaryKey(),
  username: text("username").notNull(),
  role: text("role").notNull().default("user"),
  validatorOptedIn: integer("validator_opted_in", { mode: "boolean" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const agentKeys = sqliteTable("agent_keys", {
  id: text("id").primaryKey(),
  apiKey: text("api_key").notNull().unique(),
  hiveUsername: text("hive_username").notNull(),
  label: text("label"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  lastUsedAt: text("last_used_at"),
});

// ============================================================
// File Refs (PoA 2.0)
// ============================================================

export const fileRefs = sqliteTable("file_refs", {
  id: text("id").primaryKey(),
  cid: text("cid").notNull().unique(),
  blockCids: text("block_cids").notNull(),
  blockCount: integer("block_count").notNull(),
  syncedAt: text("synced_at").notNull().default(sql`(datetime('now'))`),
});

// ============================================================
// PHASE 6: P2P CDN
// ============================================================

export const p2pSessions = sqliteTable("p2p_sessions", {
  id: text("id").primaryKey(),
  peerId: text("peer_id").notNull(),
  videoCid: text("video_cid").notNull(),
  roomId: text("room_id").notNull(),
  hiveUsername: text("hive_username"),
  isDesktopAgent: integer("is_desktop_agent", { mode: "boolean" }).notNull().default(false),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  geoRegion: text("geo_region"),
  geoCountry: text("geo_country"),
  bytesUploaded: integer("bytes_uploaded").notNull().default(0),
  bytesDownloaded: integer("bytes_downloaded").notNull().default(0),
  segmentsShared: integer("segments_shared").notNull().default(0),
  peersConnected: integer("peers_connected").notNull().default(0),
  status: text("status").notNull().default("active"),
  joinedAt: text("joined_at").notNull().default(sql`(datetime('now'))`),
  lastActiveAt: text("last_active_at").notNull().default(sql`(datetime('now'))`),
  disconnectedAt: text("disconnected_at"),
});

export const p2pContributions = sqliteTable("p2p_contributions", {
  id: text("id").primaryKey(),
  peerId: text("peer_id").notNull(),
  hiveUsername: text("hive_username"),
  videoCid: text("video_cid").notNull(),
  bytesShared: integer("bytes_shared").notNull().default(0),
  segmentsShared: integer("segments_shared").notNull().default(0),
  sessionDurationSec: integer("session_duration_sec").notNull().default(0),
  p2pRatio: real("p2p_ratio").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const p2pRooms = sqliteTable("p2p_rooms", {
  id: text("id").primaryKey(),
  videoCid: text("video_cid").notNull().unique(),
  activePeers: integer("active_peers").notNull().default(0),
  totalBytesShared: integer("total_bytes_shared").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  lastActivityAt: text("last_activity_at").notNull().default(sql`(datetime('now'))`),
});

export const p2pNetworkStats = sqliteTable("p2p_network_stats", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull().default(sql`(datetime('now'))`),
  activePeers: integer("active_peers").notNull().default(0),
  activeRooms: integer("active_rooms").notNull().default(0),
  totalBytesShared: integer("total_bytes_shared").notNull().default(0),
  avgP2pRatio: real("avg_p2p_ratio").notNull().default(0),
  bandwidthSavedBytes: integer("bandwidth_saved_bytes").notNull().default(0),
});

// ============================================================
// PHASE 7: Web of Trust
// ============================================================

export const webOfTrust = sqliteTable("web_of_trust", {
  id: text("id").primaryKey(),
  sponsorUsername: text("sponsor_username").notNull().unique(),
  vouchedUsername: text("vouched_username").notNull().unique(),
  sponsorRankAtVouch: integer("sponsor_rank_at_vouch").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  revokedAt: text("revoked_at"),
  revokeReason: text("revoke_reason"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ============================================================
// Re-export types and Zod schemas from the PG schema.
// Types are erased at compile time; Zod schemas are dialect-agnostic
// validators. This allows the desktop agent webpack to alias
// @shared/schema → @shared/schema-sqlite and still get all exports.
// ============================================================

export type {
  StorageNode, InsertStorageNode,
  File, InsertFile,
  Validator, InsertValidator,
  PoaChallenge, InsertPoaChallenge,
  HiveTransaction, InsertHiveTransaction,
  StorageAssignment,
  ValidatorBlacklist, InsertValidatorBlacklist,
  CdnNode, InsertCdnNode,
  CdnMetric, InsertCdnMetric,
  FileChunk, InsertFileChunk,
  StorageContract, InsertStorageContract,
  ContractEvent, InsertContractEvent,
  TranscodeJob, InsertTranscodeJob,
  EncoderNode, InsertEncoderNode,
  EncodingJob, InsertEncodingJob,
  EncodingProfile, InsertEncodingProfile,
  UserEncodingSettings, InsertUserEncodingSettings,
  EncoderCapability, InsertEncoderCapability,
  EncodingJobEvent, InsertEncodingJobEvent,
  EncodingJobOffer, InsertEncodingJobOffer,
  BlocklistEntry, InsertBlocklistEntry,
  PlatformBlocklist, InsertPlatformBlocklist,
  Tag, InsertTag,
  FileTag, InsertFileTag,
  TagVote, InsertTagVote,
  UserKey, InsertUserKey,
  UserNodeSettings, InsertUserNodeSettings,
  ViewEvent, InsertViewEvent,
  BeneficiaryAllocation, InsertBeneficiaryAllocation,
  PayoutHistory, InsertPayoutHistory,
  WalletDeposit, InsertWalletDeposit,
  PayoutReport, InsertPayoutReport,
  PayoutLineItem, InsertPayoutLineItem,
  P2pSession, InsertP2pSession,
  P2pContribution, InsertP2pContribution,
  P2pRoom, InsertP2pRoom,
  P2pNetworkStats, InsertP2pNetworkStats,
  WebOfTrust, InsertWebOfTrust,
} from "./schema";

export {
  insertStorageNodeSchema,
  insertFileSchema,
  insertValidatorSchema,
  insertPoaChallengeSchema,
  insertHiveTransactionSchema,
  insertValidatorBlacklistSchema,
  insertCdnNodeSchema,
  insertCdnMetricSchema,
  insertFileChunkSchema,
  insertStorageContractSchema,
  insertContractEventSchema,
  insertTranscodeJobSchema,
  insertEncoderNodeSchema,
  insertEncodingJobSchema,
  insertEncodingProfileSchema,
  insertUserEncodingSettingsSchema,
  insertEncoderCapabilitiesSchema,
  insertEncodingJobEventSchema,
  insertEncodingJobOfferSchema,
  insertBlocklistEntrySchema,
  insertPlatformBlocklistSchema,
  insertTagSchema,
  insertFileTagSchema,
  insertTagVoteSchema,
  insertUserKeySchema,
  insertUserNodeSettingsSchema,
  insertViewEventSchema,
  insertBeneficiaryAllocationSchema,
  insertPayoutHistorySchema,
  insertWalletDepositSchema,
  insertPayoutReportSchema,
  insertPayoutLineItemSchema,
  insertP2pSessionSchema,
  insertP2pContributionSchema,
  insertP2pRoomSchema,
  insertP2pNetworkStatsSchema,
  insertWebOfTrustSchema,
} from "./schema";
