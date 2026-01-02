import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================================
// PHASE 0: Core Tables (Existing)
// ============================================================

// Storage Nodes - Users running IPFS nodes and earning HBD
export const storageNodes = pgTable("storage_nodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  peerId: text("peer_id").notNull().unique(),
  hiveUsername: text("hive_username").notNull(),
  reputation: integer("reputation").notNull().default(50), // 0-100
  status: text("status").notNull().default("active"), // active, probation, banned
  totalProofs: integer("total_proofs").notNull().default(0),
  failedProofs: integer("failed_proofs").notNull().default(0),
  consecutiveFails: integer("consecutive_fails").notNull().default(0), // 3 consecutive = instant ban
  totalEarnedHbd: real("total_earned_hbd").notNull().default(0), // Track earnings
  lastSeen: timestamp("last_seen").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Files stored on the network
export const files = pgTable("files", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cid: text("cid").notNull().unique(),
  name: text("name").notNull(),
  size: text("size").notNull(),
  uploaderUsername: text("uploader_username").notNull(),
  status: text("status").notNull().default("syncing"), // syncing, pinned, warning, uploading
  replicationCount: integer("replication_count").notNull().default(0),
  confidence: integer("confidence").notNull().default(0), // 0-100
  poaEnabled: boolean("poa_enabled").notNull().default(true),
  // Phase 1: Upload tracking
  totalChunks: integer("total_chunks"),
  uploadedChunks: integer("uploaded_chunks").default(0),
  uploadSessionId: text("upload_session_id"),
  uploadExpiresAt: timestamp("upload_expires_at"),
  // Phase 3: Fingerprinting
  ssdeepHash: text("ssdeep_hash"),
  // Phase 4: Encryption
  encrypted: boolean("encrypted").notNull().default(false),
  encryptionNonce: text("encryption_nonce"),
  // Earnings tracking
  earnedHbd: real("earned_hbd").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Storage assignments - which nodes are storing which files
export const storageAssignments = pgTable("storage_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileId: varchar("file_id").notNull().references(() => files.id),
  nodeId: varchar("node_id").notNull().references(() => storageNodes.id),
  proofCount: integer("proof_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  lastProofAt: timestamp("last_proof_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Validators (Witnesses running PoA)
export const validators = pgTable("validators", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hiveUsername: text("hive_username").notNull().unique(),
  hiveRank: integer("hive_rank").notNull(),
  status: text("status").notNull().default("online"), // online, offline, syncing
  peerCount: integer("peer_count").notNull().default(0),
  performance: integer("performance").notNull().default(50), // 0-100
  jobAllocation: integer("job_allocation").notNull().default(0), // percentage
  payoutRate: real("payout_rate").notNull().default(1.0),
  version: text("version").notNull().default("v0.1.0"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// PoA Challenge Log
export const poaChallenges = pgTable("poa_challenges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  validatorId: varchar("validator_id").notNull().references(() => validators.id),
  nodeId: varchar("node_id").notNull().references(() => storageNodes.id),
  fileId: varchar("file_id").notNull().references(() => files.id),
  challengeData: text("challenge_data").notNull(), // Salt + ByteRange
  response: text("response"),
  result: text("result"), // success, fail, timeout
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Hive Transaction Log (simulated blockchain events)
export const hiveTransactions = pgTable("hive_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(), // spk_video_upload, hivepoa_announce, spk_reputation_slash, hbd_transfer
  fromUser: text("from_user").notNull(),
  toUser: text("to_user"),
  payload: text("payload").notNull(), // JSON string
  blockNumber: integer("block_number").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Validator Blacklist - nodes banned by specific validators
export const validatorBlacklists = pgTable("validator_blacklists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  validatorId: varchar("validator_id").notNull().references(() => validators.id),
  nodeId: varchar("node_id").notNull().references(() => storageNodes.id),
  reason: text("reason").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================================
// PHASE 1: CDN & Storage System
// ============================================================

// CDN Nodes - Nodes providing content delivery with health metrics
export const cdnNodes = pgTable("cdn_nodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  peerId: text("peer_id").notNull().unique(),
  hiveUsername: text("hive_username").notNull(),
  endpoint: text("endpoint").notNull(), // Public HTTPS endpoint
  geoRegion: text("geo_region").notNull().default("unknown"), // us-east, eu-west, asia-pacific, etc.
  geoCountry: text("geo_country"),
  geoContinent: text("geo_continent"),
  capacity: text("capacity").notNull().default("0"), // Storage capacity in bytes
  throughputMin: integer("throughput_min").default(0), // Minimum throughput in Mbps
  throughputMax: integer("throughput_max").default(0), // Maximum throughput in Mbps
  healthScore: text("health_score").notNull().default("WW"), // 2-char base64 encoded z-scores (raw + geo-corrected)
  rawZScore: real("raw_z_score").default(0), // Decoded raw z-score
  geoZScore: real("geo_z_score").default(0), // Decoded geo-corrected z-score
  status: text("status").notNull().default("active"), // active, degraded, offline
  lastHeartbeat: timestamp("last_heartbeat").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// CDN Metrics - Historical latency/performance data per CDN node
export const cdnMetrics = pgTable("cdn_metrics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  nodeId: varchar("node_id").notNull().references(() => cdnNodes.id),
  latencyMs: integer("latency_ms").notNull(),
  successRate: real("success_rate").notNull().default(1.0), // 0.0-1.0
  requestCount: integer("request_count").notNull().default(1),
  sourceRegion: text("source_region"), // Region of the requester
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// File Chunks - Track chunked uploads for resumable transfers
export const fileChunks = pgTable("file_chunks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileId: varchar("file_id").notNull().references(() => files.id),
  chunkIndex: integer("chunk_index").notNull(),
  chunkSize: integer("chunk_size").notNull(),
  checksum: text("checksum"), // SHA256 of chunk
  status: text("status").notNull().default("pending"), // pending, uploaded, verified
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Storage Contracts - Blockchain-verified storage agreements
export const storageContracts = pgTable("storage_contracts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileId: varchar("file_id").references(() => files.id),
  fileCid: text("file_cid").notNull(),
  uploaderUsername: text("uploader_username").notNull(),
  requestedReplication: integer("requested_replication").notNull().default(3),
  actualReplication: integer("actual_replication").notNull().default(0),
  status: text("status").notNull().default("pending"), // pending, active, completed, expired, cancelled
  hbdBudget: text("hbd_budget").notNull().default("0"), // HBD allocated for storage
  hbdSpent: text("hbd_spent").notNull().default("0"), // HBD paid out so far
  validatorApprovalAt: timestamp("validator_approval_at"),
  startsAt: timestamp("starts_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Contract Events - Track lifecycle changes for contracts
export const contractEvents = pgTable("contract_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractId: varchar("contract_id").notNull().references(() => storageContracts.id),
  eventType: text("event_type").notNull(), // created, activated, renewed, expired, cancelled, payout
  payload: text("payload"), // JSON with event details
  triggeredBy: text("triggered_by"), // Username or "system"
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================================
// PHASE 2: Video Transcoding & Hybrid Encoding System
// ============================================================

// Encoding Jobs - Hybrid encoding with self/community fallback
export const encodingJobs = pgTable("encoding_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  owner: text("owner").notNull(), // Hive username
  permlink: text("permlink").notNull(), // Video permlink
  inputCid: text("input_cid").notNull(), // Source video CID
  outputCid: text("output_cid"), // Final manifest CID
  status: text("status").notNull().default("queued"), // queued, assigned, downloading, encoding, uploading, completed, failed, cancelled
  progress: integer("progress").notNull().default(0), // 0-100
  encodingMode: text("encoding_mode").notNull().default("auto"), // self, community, auto
  encoderType: text("encoder_type"), // desktop, browser, community
  encoderNodeId: varchar("encoder_node_id"), // Community encoder if used
  encoderPeerId: text("encoder_peer_id"), // Self-encoder peer ID
  isShort: boolean("is_short").notNull().default(false), // Short video (480p only)
  qualitiesEncoded: text("qualities_encoded").default(""), // Comma-separated: 1080p,720p,480p
  videoUrl: text("video_url"), // ipfs://CID/manifest.m3u8
  webhookUrl: text("webhook_url"), // Callback URL
  webhookDelivered: boolean("webhook_delivered").notNull().default(false),
  hbdCost: text("hbd_cost").default("0"), // Cost if using community encoder
  errorMessage: text("error_message"),
  originalFilename: text("original_filename"),
  inputSizeBytes: integer("input_size_bytes"),
  outputSizeBytes: integer("output_size_bytes"),
  processingTimeSec: integer("processing_time_sec"),
  // Job assignment fields
  assignedAt: timestamp("assigned_at"),
  assignedEncoderId: varchar("assigned_encoder_id"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  // Retry logic
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  // Progress tracking
  currentStage: text("current_stage"), // downloading, encoding_1080p, encoding_720p, encoding_480p, uploading
  stageProgress: integer("stage_progress").default(0),
  // Security
  jobSignature: text("job_signature"), // For community encoders
  webhookSecret: text("webhook_secret"),
  // Priority
  priority: integer("priority").notNull().default(0), // Higher = more urgent
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Transcode Jobs - Legacy table for backward compatibility
export const transcodeJobs = pgTable("transcode_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileId: varchar("file_id").notNull().references(() => files.id),
  inputCid: text("input_cid").notNull(),
  outputCid: text("output_cid"),
  preset: text("preset").notNull(), // hls, mp4-720p, mp4-1080p, webm-720p, webm-1080p
  status: text("status").notNull().default("queued"), // queued, assigned, processing, completed, failed
  progress: integer("progress").notNull().default(0), // 0-100
  encoderNodeId: varchar("encoder_node_id").references(() => encoderNodes.id),
  hbdCost: text("hbd_cost").default("0"), // Cost of encoding
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Encoder Nodes - Nodes providing video transcoding services
export const encoderNodes = pgTable("encoder_nodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  peerId: text("peer_id").notNull().unique(),
  hiveUsername: text("hive_username").notNull(),
  endpoint: text("endpoint"), // Direct API endpoint for self-encoding
  encoderType: text("encoder_type").notNull().default("community"), // desktop, browser, community
  presetsSupported: text("presets_supported").notNull().default("hls,mp4-720p"), // Comma-separated
  basePriceHbd: text("base_price_hbd").notNull().default("0.01"), // Base price per minute of video
  // Per-quality pricing (HBD per minute of video)
  price1080p: text("price_1080p").notNull().default("0.02"),
  price720p: text("price_720p").notNull().default("0.01"),
  price480p: text("price_480p").notNull().default("0.005"),
  priceAllQualities: text("price_all_qualities").notNull().default("0.03"), // Bundle discount
  minOfferHbd: text("min_offer_hbd").notNull().default("0.005"), // Minimum offer they'll accept
  availability: text("availability").notNull().default("available"), // available, busy, offline
  jobsCompleted: integer("jobs_completed").notNull().default(0),
  jobsInProgress: integer("jobs_in_progress").notNull().default(0),
  avgProcessingTime: integer("avg_processing_time").default(0), // Seconds per minute of video
  hardwareAcceleration: text("hardware_acceleration"), // nvenc, vaapi, qsv, none
  rating: real("rating").default(5.0), // 0-5 star rating
  reputationScore: integer("reputation_score").notNull().default(100), // 0-1000, higher = better
  successRate: real("success_rate").notNull().default(100.0), // Percentage of successful jobs
  status: text("status").notNull().default("active"), // active, suspended
  lastHeartbeat: timestamp("last_heartbeat").defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Encoding Profiles - Standard output quality profiles
export const encodingProfiles = pgTable("encoding_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(), // 1080p, 720p, 480p, 360p
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  videoBitrate: text("video_bitrate").notNull(), // e.g., "4500k"
  audioBitrate: text("audio_bitrate").notNull().default("128k"),
  videoCodec: text("video_codec").notNull().default("h264"),
  audioCodec: text("audio_codec").notNull().default("aac"),
  profile: text("profile").notNull().default("high"), // baseline, main, high
  level: text("level").notNull().default("4.1"),
  preset: text("preset").notNull().default("medium"), // FFmpeg preset: ultrafast to veryslow
  isDefault: boolean("is_default").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// User Encoding Settings - Per-user encoding preferences
export const userEncodingSettings = pgTable("user_encoding_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  preferredMode: text("preferred_mode").notNull().default("auto"), // auto, self, community
  desktopAgentEnabled: boolean("desktop_agent_enabled").notNull().default(false),
  desktopAgentEndpoint: text("desktop_agent_endpoint"), // http://localhost:3002
  browserEncodingEnabled: boolean("browser_encoding_enabled").notNull().default(true),
  maxCommunityHbd: text("max_community_hbd").default("1.00"), // Max HBD willing to pay
  defaultIsShort: boolean("default_is_short").notNull().default(false),
  webhookUrl: text("webhook_url"), // Default webhook for completions
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Encoder Capabilities - Hardware and codec capabilities per encoder
export const encoderCapabilities = pgTable("encoder_capabilities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  encoderNodeId: varchar("encoder_node_id").notNull(),
  codec: text("codec").notNull(), // h264, h265, vp9, av1
  maxResolution: text("max_resolution").notNull(), // 480p, 720p, 1080p, 4k
  hwAccelType: text("hw_accel_type"), // nvenc, vaapi, qsv, videotoolbox
  estimatedSpeed: real("estimated_speed"), // x realtime (e.g., 2.5 = 2.5x faster than realtime)
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Encoding Job Events - Audit trail for job lifecycle
export const encodingJobEvents = pgTable("encoding_job_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull(),
  eventType: text("event_type").notNull(), // created, assigned, started, progress, completed, failed, retried, cancelled
  previousStatus: text("previous_status"),
  newStatus: text("new_status"),
  encoderId: varchar("encoder_id"),
  details: text("details"), // JSON with event-specific data
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Encoding Job Offers - Custom price offers from users
export const encodingJobOffers = pgTable("encoding_job_offers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull(),
  owner: text("owner").notNull(), // Hive username of uploader
  inputCid: text("input_cid").notNull(),
  qualitiesRequested: text("qualities_requested").notNull(), // Comma-separated: 1080p,720p,480p
  videoDurationSec: integer("video_duration_sec").notNull(),
  offeredHbd: text("offered_hbd").notNull(), // User's offered price
  marketPriceHbd: text("market_price_hbd").notNull(), // Current lowest market price for reference
  status: text("status").notNull().default("pending"), // pending, accepted, expired, cancelled
  acceptedEncoderId: varchar("accepted_encoder_id"),
  acceptedAt: timestamp("accepted_at"),
  expiresAt: timestamp("expires_at").notNull(), // Offer expiry time
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================================
// PHASE 3: Multi-Tier Blocklist System
// ============================================================

// Blocklist Entries - Unified blocklist with scope levels
export const blocklistEntries = pgTable("blocklist_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scope: text("scope").notNull(), // local, validator, platform
  scopeOwnerId: text("scope_owner_id"), // validator ID, platform ID, or username for local
  targetType: text("target_type").notNull(), // account, cid, ipfs_hash, ssdeep_hash, tag
  targetValue: text("target_value").notNull(), // The blocked value
  reason: text("reason"),
  severity: text("severity").notNull().default("moderate"), // low, moderate, severe, critical
  active: boolean("active").notNull().default(true),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Platform Blocklists - Platform-level content policies
export const platformBlocklists = pgTable("platform_blocklists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  platformId: text("platform_id").notNull(), // e.g., "3speak", "peakd"
  platformName: text("platform_name").notNull(),
  policyUrl: text("policy_url"),
  enforceLevel: text("enforce_level").notNull().default("warn"), // warn, block, hide
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Tags - Content tags for categorization
export const tags = pgTable("tags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  label: text("label").notNull().unique(), // nsfw, violence, spam, etc.
  category: text("category").notNull().default("content"), // content, moderation, system
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// File Tags - Community-voted tags on files
export const fileTags = pgTable("file_tags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileId: varchar("file_id").notNull().references(() => files.id),
  tagId: varchar("tag_id").notNull().references(() => tags.id),
  votesUp: integer("votes_up").notNull().default(0),
  votesDown: integer("votes_down").notNull().default(0),
  confidence: real("confidence").notNull().default(0), // Weighted score
  addedBy: text("added_by").notNull(), // Username who first added
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Tag Votes - Individual votes on file tags
export const tagVotes = pgTable("tag_votes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileTagId: varchar("file_tag_id").notNull().references(() => fileTags.id),
  voterUsername: text("voter_username").notNull(),
  voteType: text("vote_type").notNull(), // up, down
  voterReputation: integer("voter_reputation").default(50), // Snapshot of voter rep
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================================
// PHASE 4: Desktop Parity Features
// ============================================================

// User Keys - Encryption key vault for E2E encryption
export const userKeys = pgTable("user_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  keyType: text("key_type").notNull(), // public, encrypted_private
  keyValue: text("key_value").notNull(), // Base64 encoded key
  algorithm: text("algorithm").notNull().default("AES-GCM"), // Encryption algorithm
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// User Node Settings - Per-user preferences for auto-pinning etc.
export const userNodeSettings = pgTable("user_node_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  autoPinEnabled: boolean("auto_pin_enabled").notNull().default(false),
  autoPinMode: text("auto_pin_mode").notNull().default("off"), // off, all, daily_limit
  autoPinDailyLimit: integer("auto_pin_daily_limit").default(10), // Max videos per day when mode is daily_limit
  autoPinTodayCount: integer("auto_pin_today_count").notNull().default(0), // Counter for today
  autoPinLastReset: timestamp("auto_pin_last_reset").defaultNow(), // When counter was last reset
  autoPinThreshold: integer("auto_pin_threshold").default(60), // Only pin files with confidence > threshold
  maxAutoPinSize: text("max_auto_pin_size").default("104857600"), // 100MB default
  encryptByDefault: boolean("encrypt_by_default").notNull().default(false),
  // Network download settings - download existing videos from network
  downloadMode: text("download_mode").notNull().default("off"), // off, all, quota
  downloadQuota: integer("download_quota").default(10), // Number of videos to download when mode is quota
  downloadedToday: integer("downloaded_today").notNull().default(0), // Counter for today
  downloadLastReset: timestamp("download_last_reset").defaultNow(), // When counter was last reset
  downloadInProgress: boolean("download_in_progress").notNull().default(false), // Is downloading currently
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// View Events - Track when users view content (for auto-pinning)
export const viewEvents = pgTable("view_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileId: varchar("file_id").notNull().references(() => files.id),
  viewerUsername: text("viewer_username").notNull(),
  viewDurationMs: integer("view_duration_ms"),
  completed: boolean("completed").notNull().default(false), // Did they watch/view fully
  autoPinTriggered: boolean("auto_pin_triggered").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Beneficiary Allocations - Split HBD payouts to node operators
export const beneficiaryAllocations = pgTable("beneficiary_allocations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUsername: text("from_username").notNull(),
  toNodeId: varchar("to_node_id").notNull().references(() => storageNodes.id),
  percentage: real("percentage").notNull(), // 0-100
  hbdAllocated: text("hbd_allocated").notNull().default("0"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Payout History - Track all HBD payouts including splits
export const payoutHistory = pgTable("payout_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractId: varchar("contract_id").references(() => storageContracts.id),
  recipientUsername: text("recipient_username").notNull(),
  recipientNodeId: varchar("recipient_node_id").references(() => storageNodes.id),
  hbdAmount: text("hbd_amount").notNull(),
  payoutType: text("payout_type").notNull(), // storage, encoding, beneficiary, validation
  txHash: text("tx_hash"), // Hive transaction hash
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================================
// PHASE 5: Payout System
// ============================================================

// Wallet Deposits - Track incoming HBD to the central wallet
export const walletDeposits = pgTable("wallet_deposits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUsername: text("from_username").notNull(),
  hbdAmount: text("hbd_amount").notNull(),
  memo: text("memo"),
  txHash: text("tx_hash").notNull().unique(),
  purpose: text("purpose").notNull().default("storage"), // storage, tip, other
  processed: boolean("processed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Payout Reports - Validator-generated reports for batch payouts
export const payoutReports = pgTable("payout_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  validatorUsername: text("validator_username").notNull(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  totalHbd: text("total_hbd").notNull(),
  recipientCount: integer("recipient_count").notNull(),
  status: text("status").notNull().default("pending"), // pending, approved, executed, rejected
  executedAt: timestamp("executed_at"),
  executedTxHash: text("executed_tx_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Payout Line Items - Individual payout entries in a report
export const payoutLineItems = pgTable("payout_line_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reportId: varchar("report_id").notNull().references(() => payoutReports.id),
  recipientUsername: text("recipient_username").notNull(),
  hbdAmount: text("hbd_amount").notNull(),
  proofCount: integer("proof_count").notNull(),
  successRate: real("success_rate").notNull(),
  paid: boolean("paid").notNull().default(false),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================================
// Insert Schemas
// ============================================================

export const insertStorageNodeSchema = createInsertSchema(storageNodes).omit({
  id: true,
  createdAt: true,
  lastSeen: true,
});

export const insertFileSchema = createInsertSchema(files).omit({
  id: true,
  createdAt: true,
});

export const insertValidatorSchema = createInsertSchema(validators).omit({
  id: true,
  createdAt: true,
});

export const insertPoaChallengeSchema = createInsertSchema(poaChallenges).omit({
  id: true,
  createdAt: true,
});

export const insertHiveTransactionSchema = createInsertSchema(hiveTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertValidatorBlacklistSchema = createInsertSchema(validatorBlacklists).omit({
  id: true,
  createdAt: true,
});

export const insertCdnNodeSchema = createInsertSchema(cdnNodes).omit({
  id: true,
  createdAt: true,
  lastHeartbeat: true,
});

export const insertCdnMetricSchema = createInsertSchema(cdnMetrics).omit({
  id: true,
  createdAt: true,
});

export const insertFileChunkSchema = createInsertSchema(fileChunks).omit({
  id: true,
  createdAt: true,
});

export const insertStorageContractSchema = createInsertSchema(storageContracts).omit({
  id: true,
  createdAt: true,
});

export const insertContractEventSchema = createInsertSchema(contractEvents).omit({
  id: true,
  createdAt: true,
});

export const insertTranscodeJobSchema = createInsertSchema(transcodeJobs).omit({
  id: true,
  createdAt: true,
});

export const insertEncoderNodeSchema = createInsertSchema(encoderNodes).omit({
  id: true,
  createdAt: true,
  lastHeartbeat: true,
});

export const insertEncodingJobSchema = createInsertSchema(encodingJobs).omit({
  id: true,
  createdAt: true,
});

export const insertEncodingProfileSchema = createInsertSchema(encodingProfiles).omit({
  id: true,
  createdAt: true,
});

export const insertUserEncodingSettingsSchema = createInsertSchema(userEncodingSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertEncoderCapabilitiesSchema = createInsertSchema(encoderCapabilities).omit({
  id: true,
  createdAt: true,
});

export const insertEncodingJobEventSchema = createInsertSchema(encodingJobEvents).omit({
  id: true,
  createdAt: true,
});

export const insertEncodingJobOfferSchema = createInsertSchema(encodingJobOffers).omit({
  id: true,
  createdAt: true,
  acceptedAt: true,
});

export const insertBlocklistEntrySchema = createInsertSchema(blocklistEntries).omit({
  id: true,
  createdAt: true,
});

export const insertPlatformBlocklistSchema = createInsertSchema(platformBlocklists).omit({
  id: true,
  createdAt: true,
});

export const insertTagSchema = createInsertSchema(tags).omit({
  id: true,
  createdAt: true,
});

export const insertFileTagSchema = createInsertSchema(fileTags).omit({
  id: true,
  createdAt: true,
});

export const insertTagVoteSchema = createInsertSchema(tagVotes).omit({
  id: true,
  createdAt: true,
});

export const insertUserKeySchema = createInsertSchema(userKeys).omit({
  id: true,
  createdAt: true,
});

export const insertUserNodeSettingsSchema = createInsertSchema(userNodeSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertViewEventSchema = createInsertSchema(viewEvents).omit({
  id: true,
  createdAt: true,
});

export const insertBeneficiaryAllocationSchema = createInsertSchema(beneficiaryAllocations).omit({
  id: true,
  createdAt: true,
});

export const insertPayoutHistorySchema = createInsertSchema(payoutHistory).omit({
  id: true,
  createdAt: true,
});

// Phase 5: Payout System
export const insertWalletDepositSchema = createInsertSchema(walletDeposits).omit({
  id: true,
  createdAt: true,
});

export const insertPayoutReportSchema = createInsertSchema(payoutReports).omit({
  id: true,
  createdAt: true,
});

export const insertPayoutLineItemSchema = createInsertSchema(payoutLineItems).omit({
  id: true,
  createdAt: true,
});

// ============================================================
// PHASE 6: P2P CDN - Viewer-Contributed Resources
// ============================================================

// P2P Sessions - Active viewer connections in P2P mesh
export const p2pSessions = pgTable("p2p_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  peerId: text("peer_id").notNull(),
  videoCid: text("video_cid").notNull(),
  roomId: text("room_id").notNull(),
  hiveUsername: text("hive_username"),
  isDesktopAgent: boolean("is_desktop_agent").notNull().default(false),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  geoRegion: text("geo_region"),
  geoCountry: text("geo_country"),
  bytesUploaded: integer("bytes_uploaded").notNull().default(0),
  bytesDownloaded: integer("bytes_downloaded").notNull().default(0),
  segmentsShared: integer("segments_shared").notNull().default(0),
  peersConnected: integer("peers_connected").notNull().default(0),
  status: text("status").notNull().default("active"),
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at").notNull().defaultNow(),
  disconnectedAt: timestamp("disconnected_at"),
});

// P2P Contributions - Aggregated bandwidth contributions for rewards
export const p2pContributions = pgTable("p2p_contributions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  peerId: text("peer_id").notNull(),
  hiveUsername: text("hive_username"),
  videoCid: text("video_cid").notNull(),
  bytesShared: integer("bytes_shared").notNull().default(0),
  segmentsShared: integer("segments_shared").notNull().default(0),
  sessionDurationSec: integer("session_duration_sec").notNull().default(0),
  p2pRatio: real("p2p_ratio").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// P2P Rooms - Video rooms for peer coordination
export const p2pRooms = pgTable("p2p_rooms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  videoCid: text("video_cid").notNull().unique(),
  activePeers: integer("active_peers").notNull().default(0),
  totalBytesShared: integer("total_bytes_shared").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
});

// P2P Network Stats - Aggregate network statistics
export const p2pNetworkStats = pgTable("p2p_network_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  activePeers: integer("active_peers").notNull().default(0),
  activeRooms: integer("active_rooms").notNull().default(0),
  totalBytesShared: integer("total_bytes_shared").notNull().default(0),
  avgP2pRatio: real("avg_p2p_ratio").notNull().default(0),
  bandwidthSavedBytes: integer("bandwidth_saved_bytes").notNull().default(0),
});

// Phase 6: P2P CDN Insert Schemas
export const insertP2pSessionSchema = createInsertSchema(p2pSessions).omit({
  id: true,
  joinedAt: true,
  lastActiveAt: true,
});

export const insertP2pContributionSchema = createInsertSchema(p2pContributions).omit({
  id: true,
  createdAt: true,
});

export const insertP2pRoomSchema = createInsertSchema(p2pRooms).omit({
  id: true,
  createdAt: true,
  lastActivityAt: true,
});

export const insertP2pNetworkStatsSchema = createInsertSchema(p2pNetworkStats).omit({
  id: true,
  timestamp: true,
});

// ============================================================
// Types
// ============================================================

// Phase 0: Core Types
export type StorageNode = typeof storageNodes.$inferSelect;
export type InsertStorageNode = z.infer<typeof insertStorageNodeSchema>;

export type File = typeof files.$inferSelect;
export type InsertFile = z.infer<typeof insertFileSchema>;

export type Validator = typeof validators.$inferSelect;
export type InsertValidator = z.infer<typeof insertValidatorSchema>;

export type PoaChallenge = typeof poaChallenges.$inferSelect;
export type InsertPoaChallenge = z.infer<typeof insertPoaChallengeSchema>;

export type HiveTransaction = typeof hiveTransactions.$inferSelect;
export type InsertHiveTransaction = z.infer<typeof insertHiveTransactionSchema>;

export type StorageAssignment = typeof storageAssignments.$inferSelect;

export type ValidatorBlacklist = typeof validatorBlacklists.$inferSelect;
export type InsertValidatorBlacklist = z.infer<typeof insertValidatorBlacklistSchema>;

// Phase 1: CDN & Storage Types
export type CdnNode = typeof cdnNodes.$inferSelect;
export type InsertCdnNode = z.infer<typeof insertCdnNodeSchema>;

export type CdnMetric = typeof cdnMetrics.$inferSelect;
export type InsertCdnMetric = z.infer<typeof insertCdnMetricSchema>;

export type FileChunk = typeof fileChunks.$inferSelect;
export type InsertFileChunk = z.infer<typeof insertFileChunkSchema>;

export type StorageContract = typeof storageContracts.$inferSelect;
export type InsertStorageContract = z.infer<typeof insertStorageContractSchema>;

export type ContractEvent = typeof contractEvents.$inferSelect;
export type InsertContractEvent = z.infer<typeof insertContractEventSchema>;

// Phase 2: Transcoding & Hybrid Encoding Types
export type TranscodeJob = typeof transcodeJobs.$inferSelect;
export type InsertTranscodeJob = z.infer<typeof insertTranscodeJobSchema>;

export type EncoderNode = typeof encoderNodes.$inferSelect;
export type InsertEncoderNode = z.infer<typeof insertEncoderNodeSchema>;

export type EncodingJob = typeof encodingJobs.$inferSelect;
export type InsertEncodingJob = z.infer<typeof insertEncodingJobSchema>;

export type EncodingProfile = typeof encodingProfiles.$inferSelect;
export type InsertEncodingProfile = z.infer<typeof insertEncodingProfileSchema>;

export type UserEncodingSettings = typeof userEncodingSettings.$inferSelect;
export type InsertUserEncodingSettings = z.infer<typeof insertUserEncodingSettingsSchema>;

export type EncoderCapability = typeof encoderCapabilities.$inferSelect;
export type InsertEncoderCapability = z.infer<typeof insertEncoderCapabilitiesSchema>;

export type EncodingJobEvent = typeof encodingJobEvents.$inferSelect;
export type InsertEncodingJobEvent = z.infer<typeof insertEncodingJobEventSchema>;

export type EncodingJobOffer = typeof encodingJobOffers.$inferSelect;
export type InsertEncodingJobOffer = z.infer<typeof insertEncodingJobOfferSchema>;

// Phase 3: Blocklist Types
export type BlocklistEntry = typeof blocklistEntries.$inferSelect;
export type InsertBlocklistEntry = z.infer<typeof insertBlocklistEntrySchema>;

export type PlatformBlocklist = typeof platformBlocklists.$inferSelect;
export type InsertPlatformBlocklist = z.infer<typeof insertPlatformBlocklistSchema>;

export type Tag = typeof tags.$inferSelect;
export type InsertTag = z.infer<typeof insertTagSchema>;

export type FileTag = typeof fileTags.$inferSelect;
export type InsertFileTag = z.infer<typeof insertFileTagSchema>;

export type TagVote = typeof tagVotes.$inferSelect;
export type InsertTagVote = z.infer<typeof insertTagVoteSchema>;

// Phase 4: Desktop Parity Types
export type UserKey = typeof userKeys.$inferSelect;
export type InsertUserKey = z.infer<typeof insertUserKeySchema>;

export type UserNodeSettings = typeof userNodeSettings.$inferSelect;
export type InsertUserNodeSettings = z.infer<typeof insertUserNodeSettingsSchema>;

export type ViewEvent = typeof viewEvents.$inferSelect;
export type InsertViewEvent = z.infer<typeof insertViewEventSchema>;

export type BeneficiaryAllocation = typeof beneficiaryAllocations.$inferSelect;
export type InsertBeneficiaryAllocation = z.infer<typeof insertBeneficiaryAllocationSchema>;

export type PayoutHistory = typeof payoutHistory.$inferSelect;
export type InsertPayoutHistory = z.infer<typeof insertPayoutHistorySchema>;

// Phase 5: Payout System Types
export type WalletDeposit = typeof walletDeposits.$inferSelect;
export type InsertWalletDeposit = z.infer<typeof insertWalletDepositSchema>;

export type PayoutReport = typeof payoutReports.$inferSelect;
export type InsertPayoutReport = z.infer<typeof insertPayoutReportSchema>;

export type PayoutLineItem = typeof payoutLineItems.$inferSelect;
export type InsertPayoutLineItem = z.infer<typeof insertPayoutLineItemSchema>;

// Phase 6: P2P CDN Types
export type P2pSession = typeof p2pSessions.$inferSelect;
export type InsertP2pSession = z.infer<typeof insertP2pSessionSchema>;

export type P2pContribution = typeof p2pContributions.$inferSelect;
export type InsertP2pContribution = z.infer<typeof insertP2pContributionSchema>;

export type P2pRoom = typeof p2pRooms.$inferSelect;
export type InsertP2pRoom = z.infer<typeof insertP2pRoomSchema>;

export type P2pNetworkStats = typeof p2pNetworkStats.$inferSelect;
export type InsertP2pNetworkStats = z.infer<typeof insertP2pNetworkStatsSchema>;
