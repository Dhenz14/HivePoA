import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, bigint, timestamp, boolean, real, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
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
  endpoint: text("endpoint"), // WebSocket URL for PoA validation (e.g., ws://node.example.com/validate)
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
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
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
  storageTierId: text("storage_tier_id"), // starter, standard, creator — null for legacy/custom contracts
  status: text("status").notNull().default("pending"), // pending, active, completed, expired, cancelled
  hbdBudget: text("hbd_budget").notNull().default("0"), // HBD allocated for storage
  hbdSpent: text("hbd_spent").notNull().default("0"), // HBD paid out so far
  rewardPerChallenge: text("reward_per_challenge").notNull().default("0.005"), // HBD paid per successful PoA proof
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
  broadcastStatus: text("broadcast_status"), // success, failed, simulated, skipped
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
// Validator Sessions (persistent, survives server restarts)
// ============================================================

export const userSessions = pgTable("user_sessions", {
  token: varchar("token").primaryKey(),
  username: text("username").notNull(),
  role: text("role").notNull().default("user"), // "user" | "validator" | "agent"
  validatorOptedIn: boolean("validator_opted_in"), // null = not yet chosen, true = opted in, false = declined/resigned
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Agent API Keys — desktop/server encoding agents authenticate with API keys
export const agentKeys = pgTable("agent_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  apiKey: varchar("api_key").notNull().unique(),
  hiveUsername: text("hive_username").notNull(),
  label: text("label"), // e.g. "My Desktop Agent"
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
});

// ============================================================
// File Refs — IPFS Merkle DAG block CID lists (SPK PoA 2.0)
// Validators store only this metadata, NOT the actual file data.
// This enables lightweight verification: the validator fetches
// random sub-blocks on-demand during proof verification.
// ============================================================

export const fileRefs = pgTable("file_refs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cid: text("cid").notNull().unique(),
  blockCids: text("block_cids").notNull(), // JSON array of sub-block CIDs
  blockCount: integer("block_count").notNull(),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
});

// ============================================================
// PHASE 7: Web of Trust — Witness-Vouched Validators
// ============================================================

export const webOfTrust = pgTable("web_of_trust", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sponsorUsername: text("sponsor_username").notNull().unique(), // Witness who vouches (max 1 per witness)
  vouchedUsername: text("vouched_username").notNull().unique(), // Non-witness being vouched (max 1 sponsor)
  sponsorRankAtVouch: integer("sponsor_rank_at_vouch").notNull(),
  active: boolean("active").notNull().default(true),
  revokedAt: timestamp("revoked_at"),
  revokeReason: text("revoke_reason"), // "manual" | "witness_dropped"
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================================
// PHASE 8: Multisig Treasury
// ============================================================

// Treasury Signers — Top-150 witnesses OR WoT-vouched users who opted in as multisig signers
export const treasurySigners = pgTable("treasury_signers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),                 // Hive username (top-150 witness or WoT-vouched)
  status: text("status").notNull().default("active"),            // 'active' | 'leaving' | 'cooldown' | 'removed'
  weight: integer("weight").notNull().default(1),                // Authority weight on @hivepoa-treasury
  joinedAt: timestamp("joined_at"),
  leftAt: timestamp("left_at"),
  cooldownUntil: timestamp("cooldown_until"),                    // When they can rejoin after opt-out
  optEvents: integer("opt_events").notNull().default(0),         // Opt-in/out cycle count (churn tracking)
  lastHeartbeat: timestamp("last_heartbeat"),                    // Last signing-daemon heartbeat
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Treasury Vouches — WoT extension for treasury signers (1:N, unlike validator WoT which is 1:1)
// A top-150 witness can vouch for multiple treasury signer candidates.
// A candidate needs 3+ vouches from top-150 witnesses to qualify.
export const treasuryVouches = pgTable("treasury_vouches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  voucherUsername: text("voucher_username").notNull(),             // Top-150 witness doing the vouching
  candidateUsername: text("candidate_username").notNull(),         // Who they're vouching for
  voucherRankAtVouch: integer("voucher_rank_at_vouch").notNull(), // Witness rank at time of vouch
  active: boolean("active").notNull().default(true),
  revokedAt: timestamp("revoked_at"),
  revokeReason: text("revoke_reason"),                            // 'manual' | 'voucher_deranked'
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("treasury_vouches_voucher_candidate_active_idx")
    .on(table.voucherUsername, table.candidateUsername)
    .where(sql`active = true`),
]);

// Treasury Transactions — Signature collection + audit trail for multisig txs
export const treasuryTransactions = pgTable("treasury_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  txType: text("tx_type").notNull(),                             // 'transfer' | 'authority_update'
  status: text("status").notNull().default("pending"),           // 'pending' | 'signing' | 'broadcast' | 'expired' | 'failed'
  operationsJson: text("operations_json").notNull(),             // Serialized Hive operations array
  txDigest: text("tx_digest").notNull().unique(),                // SHA256 of serialized tx (signers sign this)
  signatures: jsonb("signatures").notNull().default({}),         // { "username": "sig_hex", ... }
  threshold: integer("threshold").notNull(),                     // Required signatures at time of creation
  expiresAt: timestamp("expires_at").notNull(),                  // Tx expiration
  initiatedBy: text("initiated_by").notNull(),                   // 'system' or username
  broadcastTxId: text("broadcast_tx_id"),                        // Hive tx ID after successful broadcast
  metadata: jsonb("metadata"),                                   // Context: recipient, amount, memo, etc.
  broadcastAfter: timestamp("broadcast_after"),                  // Delayed broadcast time (null = immediate)
  delaySeconds: integer("delay_seconds"),                        // Delay duration for display
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

// Treasury Audit Log — Persistent record of all signing events
export const treasuryAuditLog = pgTable("treasury_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  txId: text("tx_id").notNull(),
  signerUsername: text("signer_username").notNull(),
  action: text("action").notNull(), // requested, signed, rejected, expired, broadcast, failed
  nonce: text("nonce"),
  rejectReason: text("reject_reason"),
  txDigest: text("tx_digest"),
  metadata: jsonb("metadata"),
  anomalyFlags: text("anomaly_flags"),                           // Comma-separated anomaly types, or null
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Treasury Freeze State — Emergency kill switch
export const treasuryFreezeState = pgTable("treasury_freeze_state", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  frozen: boolean("frozen").notNull().default(false),
  frozenBy: text("frozen_by"),
  frozenAt: timestamp("frozen_at"),
  unfreezeVotes: jsonb("unfreeze_votes").notNull().default([]),  // string[] of usernames who voted to unfreeze
  unfreezeThreshold: integer("unfreeze_threshold"),              // 80% of signers at freeze time
  reason: text("reason"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================================
// PHASE 9: Community Content Moderation
// ============================================================

// Content Flags - Community reports on harmful/illegal content
export const contentFlags = pgTable("content_flags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cid: text("cid").notNull(),
  fileId: varchar("file_id").references(() => files.id),
  reporterUsername: text("reporter_username").notNull(),
  reason: text("reason").notNull(), // illegal, copyright, malware, spam, harassment, other
  description: text("description"),
  severity: text("severity").notNull().default("moderate"), // low, moderate, severe, critical
  status: text("status").notNull().default("pending"), // pending, reviewed, confirmed, dismissed
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  flagCount: integer("flag_count").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Uploader Bans - Node-level bans on uploaders by Hive username
export const uploaderBans = pgTable("uploader_bans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  bannedUsername: text("banned_username").notNull(),
  bannedBy: text("banned_by").notNull(), // validator/node operator username
  reason: text("reason").notNull(),
  scope: text("scope").notNull().default("local"), // local (single node), network (validator-endorsed)
  active: boolean("active").notNull().default(true),
  expiresAt: timestamp("expires_at"),
  relatedFlagId: varchar("related_flag_id").references(() => contentFlags.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
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

// ============================================================
// PHASE 10: GPU Compute Marketplace
// ============================================================

// Compute Nodes - GPU workers registered to execute typed workloads
// One Hive account can register multiple nodes (different machines / GPUs)
export const computeNodes = pgTable("compute_nodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  nodeInstanceId: text("node_instance_id").notNull().unique(), // stable per-device identity (worker generates on first run)
  hiveUsername: text("hive_username").notNull(), // owner — one account can own multiple nodes
  apiKeyId: varchar("api_key_id"), // references agentKeys, set on registration
  status: text("status").notNull().default("online"), // online, offline, draining, banned
  maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(1), // how many jobs this node can run at once
  // Hardware specs (queryable columns, not JSON)
  gpuModel: text("gpu_model").notNull(), // "RTX 4090", "A100-80GB"
  gpuVramGb: integer("gpu_vram_gb").notNull(),
  cudaVersion: text("cuda_version"),
  cpuCores: integer("cpu_cores"),
  ramGb: integer("ram_gb"),
  // Capabilities
  supportedWorkloads: text("supported_workloads").notNull().default(""), // comma-separated: eval_sweep,benchmark_run,domain_lora_train
  cachedModels: text("cached_models").notNull().default(""), // comma-separated model IDs cached locally
  workerVersion: text("worker_version"),
  // Economics
  pricePerHourHbd: text("price_per_hour_hbd").notNull().default("0.50"),
  // Trust
  reputationScore: integer("reputation_score").notNull().default(0), // 0-100, starts at 0 (warm-up)
  totalJobsCompleted: integer("total_jobs_completed").notNull().default(0),
  totalJobsFailed: integer("total_jobs_failed").notNull().default(0),
  totalHbdEarned: text("total_hbd_earned").notNull().default("0"),
  // State
  jobsInProgress: integer("jobs_in_progress").notNull().default(0),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  lastPoaChallengeAt: timestamp("last_poa_challenge_at"), // when coordinator last issued a PoA challenge to this node
  metadataJson: text("metadata_json"), // overflow for non-queryable fields
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Compute Jobs - Typed workload execution requests
export const computeJobs = pgTable("compute_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  creatorUsername: text("creator_username").notNull(), // Hive username
  workloadType: text("workload_type").notNull(), // eval_sweep, benchmark_run, weakness_targeted_generation, domain_lora_train, adapter_validation
  state: text("state").notNull().default("queued"), // queued, leased, running, submitted, verifying, accepted, rejected, expired, cancelled, settled
  priority: integer("priority").notNull().default(0), // higher = more urgent
  // Job manifest (immutable definition of what to execute)
  manifestJson: text("manifest_json").notNull(), // full workload manifest (model, config, data CIDs, runtime versions)
  manifestSha256: text("manifest_sha256").notNull(), // integrity hash
  // Resource requirements
  minVramGb: integer("min_vram_gb").notNull().default(16),
  requiredModels: text("required_models").notNull().default(""), // comma-separated base models needed
  // Budget & lifecycle
  budgetHbd: text("budget_hbd").notNull().default("0"),
  reservedBudgetHbd: text("reserved_budget_hbd").notNull().default("0"), // held during execution
  leaseSeconds: integer("lease_seconds").notNull().default(3600), // max time for a single attempt
  maxAttempts: integer("max_attempts").notNull().default(3),
  attemptCount: integer("attempt_count").notNull().default(0),
  // Verification
  verificationPolicyJson: text("verification_policy_json"), // workload-specific verification config
  // GPU PoA: directed challenge jobs target a specific node; null for open-market jobs
  targetNodeId: varchar("target_node_id"), // references computeNodes.id; enforced in application code
  // Single-winner identity — at most one accepted attempt per job (Phase 0 invariant)
  // NOTE: Cannot use .references(() => computeJobAttempts.id) due to circular dependency.
  // FK enforced via DB migration SQL. Cross-job guard enforced in application code.
  acceptedAttemptId: varchar("accepted_attempt_id"),
  // Timestamps
  deadlineAt: timestamp("deadline_at"), // hard deadline for entire job
  cancelledAt: timestamp("cancelled_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Compliance-challenge exact-once scoring: set atomically with the reputation mutation.
  // Prevents restart double-score. NULL = unscored; non-null = already applied.
  poaScoredAt: timestamp("poa_scored_at"),
});

// Compute Job Attempts - Each lease/execution attempt of a job
export const computeJobAttempts = pgTable("compute_job_attempts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => computeJobs.id),
  nodeId: varchar("node_id").notNull().references(() => computeNodes.id),
  leaseToken: text("lease_token").notNull(), // random token for this attempt
  nonce: text("nonce").notNull(), // server-issued UUIDv4 per attempt — idempotency key component
  state: text("state").notNull().default("leased"), // leased, running, submitted, accepted, rejected, timed_out, failed
  // Progress
  progressPct: integer("progress_pct").notNull().default(0), // 0-100
  currentStage: text("current_stage"), // downloading, processing, uploading
  // Output artifact (one primary output per attempt)
  outputCid: text("output_cid"),
  outputSha256: text("output_sha256"),
  outputSizeBytes: integer("output_size_bytes"),
  outputTransportUrl: text("output_transport_url"), // optional fast HTTP URL
  // Telemetry (not trusted for verification, used for debugging)
  metricsJson: text("metrics_json"), // loss curves, timing, GPU utilization
  resultJson: text("result_json"), // structured result per output_schema
  stderrTail: text("stderr_tail"), // last N lines of stderr for debugging
  failureReason: text("failure_reason"),
  // Phase 0: Transaction integrity
  leaseExpiresAt: timestamp("lease_expires_at").notNull(), // server-computed: createdAt + job.leaseSeconds
  submissionPayloadHash: text("submission_payload_hash"), // SHA256(outputSha256 + resultJson) — divergent-replay detection
  provenanceJson: text("provenance_json"), // structured provenance metadata (≤ 64 KB)
  // Phase 2A: Challenge rollup (derived cache, not authority — recomputable from checkpoints + bundles)
  challengeProtocolVersion: integer("challenge_protocol_version"), // 1 for Phase 2A; NULL for non-challenge attempts
  challengeProfileId: varchar("challenge_profile_id"), // FK → compute_resource_class_profiles.profile_id (application-enforced)
  firstProgressAt: timestamp("first_progress_at"), // when first checkpoint arrived
  checkpointCount: integer("checkpoint_count").notNull().default(0), // count of checkpoints received
  transcriptHash: text("transcript_hash"), // final transcript_entry_hash (convenience copy from last checkpoint)
  // Timestamps
  startedAt: timestamp("started_at"),
  heartbeatAt: timestamp("heartbeat_at"),
  submittedAt: timestamp("submitted_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  // Composite uniqueness: enables bundle (attempt_id, job_id) cross-job drift prevention.
  // Bundle FK to this composite is enforced in application code (Drizzle lacks composite FK support).
  uniqueIndex("compute_job_attempts_id_job_id_idx")
    .on(table.id, table.jobId),
]);

// Compute Verifications - Trusted verifier outputs
export const computeVerifications = pgTable("compute_verifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => computeJobs.id),
  attemptId: varchar("attempt_id").notNull().references(() => computeJobAttempts.id),
  verifierType: text("verifier_type").notNull(), // structural, hidden_loss, hidden_eval, merge_candidacy
  verifierVersion: text("verifier_version").notNull().default("1.0.0"),
  result: text("result").notNull(), // pass, fail, soft_fail
  score: real("score"), // 0.0-1.0 for scored verifications
  detailsJson: text("details_json"), // verification-specific details
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Compute Payouts - Three-stage payment tracking
export const computePayouts = pgTable("compute_payouts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").notNull().references(() => computeJobs.id),
  attemptId: varchar("attempt_id").references(() => computeJobAttempts.id),
  nodeId: varchar("node_id").notNull().references(() => computeNodes.id),
  amountHbd: text("amount_hbd").notNull(),
  reason: text("reason").notNull(), // validity_fee, completion_fee, bonus, cancellation_refund, creator_refund
  status: text("status").notNull().default("pending"), // pending, queued, broadcast, confirmed, failed
  treasuryTxId: varchar("treasury_tx_id"), // links to treasury transaction
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Phase 1 Step 2: Compute Wallets — per-user funding accounts
export const computeWallets = pgTable("compute_wallets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hiveUsername: text("hive_username").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Phase 1 Step 2: Compute Wallet Ledger — immutable append-only financial entries
// Balance is always derived: SUM(amount_hbd) WHERE wallet_id = ?
export const computeWalletLedger = pgTable("compute_wallet_ledger", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletId: varchar("wallet_id").notNull().references(() => computeWallets.id),
  entryType: text("entry_type").notNull(), // deposit, reservation, release, payout
  amountHbd: text("amount_hbd").notNull(), // positive = credit, negative = debit
  referenceType: text("reference_type").notNull(), // hive_tx, compute_job, compute_payout
  referenceId: text("reference_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  chainTxId: text("chain_tx_id"),       // Hive transaction hash (deposits only)
  chainBlockNum: integer("chain_block_num"), // irreversible block number (deposits only)
  memo: text("memo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Phase 1 Step 3: Compute Payout Broadcast Attempts — durable pre-send identity
export const computePayoutBroadcasts = pgTable("compute_payout_broadcasts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  payoutId: varchar("payout_id").notNull().references(() => computePayouts.id),
  attemptNumber: integer("attempt_number").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  recipientUsername: text("recipient_username").notNull(),
  amountHbd: text("amount_hbd").notNull(),
  memo: text("memo").notNull(), // hivepoa:compute:{payoutId}:{attemptNumber}
  hiveTxId: text("hive_tx_id"),
  status: text("status").notNull().default("created"), // created, sent, confirmed, failed_expired, failed_error, ambiguous
  chainBlockNum: integer("chain_block_num"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// ============================================================
// PHASE 2A: Staged Challenge Protocol — Resource-Class Profiles,
//           Precomputed Stage Bundles, Challenge Checkpoints
// ============================================================

// Resource-Class Profiles — immutable parameter sets for challenge workloads.
// Each row defines the full workload shape, deadline bands, and pool config
// for one (protocol_version, class) pair. Evidence-relevant: the verifier
// needs these values, so they live in a table, not config.
// Immutable once referenced by a bundle. Soft-disable via is_active only.
export const computeResourceClassProfiles = pgTable("compute_resource_class_profiles", {
  profileId: varchar("profile_id").primaryKey().default(sql`gen_random_uuid()`),
  classId: integer("class_id").notNull(), // stable numeric ID used in kernel digest metadata (le32)
  className: text("class_name").notNull(), // "gpu-small", "gpu-medium", "gpu-large"
  protocolVersion: integer("protocol_version").notNull(), // 1 for phase2a-kernel-v1
  kernelId: text("kernel_id").notNull(), // "phase2a-kernel-v1"
  // Workload shape (defines the computation)
  m: integer("m").notNull(), // matrix rows
  n: integer("n").notNull(), // matrix cols
  k: integer("k").notNull(), // batch width
  mixRounds: integer("mix_rounds").notNull(),
  stagesPerChallenge: integer("stages_per_challenge").notNull(), // 5
  // Deadline bands (milliseconds)
  firstProgressDeadlineMs: integer("first_progress_deadline_ms").notNull(),
  stageDeadlineMs: integer("stage_deadline_ms").notNull(), // per-stage ceiling
  completionDeadlineMs: integer("completion_deadline_ms").notNull(), // issue-to-final-submit
  // Pool management
  poolTarget: integer("pool_target").notNull(), // precompute target per class
  poolLowWatermarkPct: integer("pool_low_watermark_pct").notNull(), // 50 → begin replenishment
  poolCriticalWatermarkPct: integer("pool_critical_watermark_pct").notNull(), // 25 → stop issuing
  // Lifecycle
  isActive: boolean("is_active").notNull().default(true), // soft-disable for issuance, never delete
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("resource_class_profiles_version_class_id_idx")
    .on(table.protocolVersion, table.classId),
  uniqueIndex("resource_class_profiles_version_class_name_idx")
    .on(table.protocolVersion, table.className),
]);

// Challenge Stage Bundles — precomputed challenge material + runtime bind/reveal facts.
// Lifecycle: precomputed as orphans (job_id/attempt_id NULL) → claimed atomically as a
// challenge set → stages revealed lazily one at a time.
//
// Mutation contract:
//   Precomputed columns: NEVER modified after insert.
//   job_id, attempt_id, claimed_at: set ONCE (pool → claimed).
//   stage_issued_at, stage_deadline_at: set ONCE per stage (reveal).
//   After all reveals: no further edits.
//
// Pool availability: attempt_id IS NULL.
// workload_params_json is a SNAPSHOT built at precompute time from the authoritative
// profile row. Never regenerated from current profile values.
export const computeChallengeStageB = pgTable("compute_challenge_stage_bundles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  challengeSetId: varchar("challenge_set_id").notNull(), // groups N stages into one atomic claimable unit
  profileId: varchar("profile_id").notNull().references(() => computeResourceClassProfiles.profileId),
  stageIndex: integer("stage_index").notNull(), // 0-based, contiguous
  // Precomputed material (immutable once inserted)
  rootNonce: text("root_nonce").notNull(), // UUIDv4, shared across all stages in a set
  stageNonce: text("stage_nonce").notNull(), // hex, derived: SHA-256(rootNonce || stage_index_le32)
  expectedDigest: text("expected_digest").notNull(), // hex, precomputed reference digest
  workloadParamsJson: text("workload_params_json").notNull(), // snapshot: {protocol_version, kernel_id, class_id, stage_index, stage_nonce, M, N, K, mix_rounds}
  precomputedAt: timestamp("precomputed_at").notNull().defaultNow(),
  // Runtime bind/reveal (one-way mutable)
  jobId: varchar("job_id").references(() => computeJobs.id), // NULL in pool, set once at claim
  attemptId: varchar("attempt_id").references(() => computeJobAttempts.id), // NULL in pool, set once at claim
  claimedAt: timestamp("claimed_at"), // set once when bound to attempt
  stageIssuedAt: timestamp("stage_issued_at"), // set once when revealed to worker
  stageDeadlineAt: timestamp("stage_deadline_at"), // computed: stage_issued_at + profile.stage_deadline_ms
}, (table) => [
  uniqueIndex("challenge_stage_bundles_set_stage_idx")
    .on(table.challengeSetId, table.stageIndex),
  // Hot path: verification and reveal joins
  index("challenge_stage_bundles_attempt_stage_idx")
    .on(table.attemptId, table.stageIndex),
  // Orphan pool scan: find unclaimed sets for a given profile
  index("challenge_stage_bundles_pool_idx")
    .on(table.profileId, table.precomputedAt)
    .where(sql`attempt_id IS NULL`),
]);

// Challenge Checkpoints — canonical stage-receipt store (NOT a transport log).
// Row exists = checkpoint received. No status column. No update path.
// Verdicts derived at verification time by comparing result_digest against
// bundle.expected_digest. Insert-only; each (attempt, stage) slot accepts
// exactly one INSERT. Duplicate transport attempts deduped before insert.
export const computeChallengeCheckpoints = pgTable("compute_challenge_checkpoints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  attemptId: varchar("attempt_id").notNull().references(() => computeJobAttempts.id),
  stageIndex: integer("stage_index").notNull(),
  // Worker-submitted evidence (immutable once inserted)
  stageNonce: text("stage_nonce").notNull(), // worker echoes nonce (cross-check against bundle)
  resultDigest: text("result_digest").notNull(), // hex, what the worker computed
  checkpointReceivedAt: timestamp("checkpoint_received_at").notNull(), // server receipt time (timing authority)
  telemetryJson: text("telemetry_json"), // optional worker self-report (untrusted)
  // Transcript hash chain
  transcriptPrevHash: text("transcript_prev_hash").notNull(), // hex, "" for stage 0
  transcriptEntryHash: text("transcript_entry_hash").notNull(), // hex, H(prev || stage_index || result_digest)
  // Metadata
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  // Canonical: exactly one checkpoint per (attempt, stage)
  uniqueIndex("challenge_checkpoints_attempt_stage_idx")
    .on(table.attemptId, table.stageIndex),
]);

// ============================================================
// PHASE 2B: VRAM Class Evidence (insert-only observation log)
// ============================================================

// Every challenge outcome for protocol_version >= 2 profiles produces an observation.
// Rows are insert-only: never updated, never deleted (except by TTL-based retention).
// Certification state is derived from the log, not stored.
export const computeVramClassEvidence = pgTable("compute_vram_class_evidence", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  nodeId: varchar("node_id").notNull().references(() => computeNodes.id),
  resourceClassProfileId: varchar("resource_class_profile_id").notNull()
    .references(() => computeResourceClassProfiles.profileId),
  status: text("status").notNull(), // 'pass' | 'fail' | 'inconclusive'
  observedAt: timestamp("observed_at").notNull(),
  expiresAt: timestamp("expires_at"), // null = no expiry (operational policy sets this)
  challengeAttemptId: varchar("challenge_attempt_id")
    .references(() => computeJobAttempts.id),
  failureReason: text("failure_reason"), // VRAM_OOM, STAGE_DEADLINE_MISSED, STAGE_DIGEST_MISMATCH, FIRST_PROGRESS_MISSED, COMPLETION_DEADLINE_MISSED
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  // Fast lookup: certification derivation for (node, profile)
  index("vram_evidence_node_profile_idx")
    .on(table.nodeId, table.resourceClassProfileId, table.observedAt),
  // Attempt linkage (unique: one observation per attempt)
  uniqueIndex("vram_evidence_attempt_idx")
    .on(table.challengeAttemptId),
]);

// ============================================================
// SPIRIT BOMB: Community Cloud Tier System
// ============================================================

// GPU Cluster Groups — geo-aware affinity groups of compute nodes
// Nodes within a cluster have <50ms latency to each other
export const gpuClusters = pgTable("gpu_clusters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  region: text("region").notNull(), // geo region identifier (e.g., "us-east", "eu-west")
  geoHash: text("geo_hash"), // geohash prefix for proximity grouping
  status: text("status").notNull().default("forming"), // forming, active, degraded, dissolved
  totalGpus: integer("total_gpus").notNull().default(0),
  totalVramGb: integer("total_vram_gb").notNull().default(0),
  avgLatencyMs: real("avg_latency_ms"), // average intra-cluster latency
  maxLatencyMs: real("max_latency_ms"), // worst-case intra-cluster latency
  // Capabilities derived from member GPUs
  canTensorParallel: boolean("can_tensor_parallel").notNull().default(false), // TP requires <10ms
  canPipelineParallel: boolean("can_pipeline_parallel").notNull().default(true),
  // Coordinator info
  coordinatorNodeId: varchar("coordinator_node_id").references(() => computeNodes.id),
  lastHealthCheck: timestamp("last_health_check"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("gpu_clusters_region_idx").on(table.region),
  index("gpu_clusters_status_idx").on(table.status),
]);

// GPU Cluster Membership — which compute nodes belong to which clusters
export const gpuClusterMembers = pgTable("gpu_cluster_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clusterId: varchar("cluster_id").notNull().references(() => gpuClusters.id),
  nodeId: varchar("node_id").notNull().references(() => computeNodes.id),
  role: text("role").notNull().default("worker"), // coordinator, worker
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
  lastPingMs: real("last_ping_ms"), // latency to coordinator
  gpuModel: text("gpu_model"),
  vramGb: integer("vram_gb"),
  bandwidthGbps: real("bandwidth_gbps"), // measured network bandwidth
  status: text("status").notNull().default("active"), // active, draining, disconnected
}, (table) => [
  uniqueIndex("gpu_cluster_member_unique_idx").on(table.clusterId, table.nodeId),
  index("gpu_cluster_member_node_idx").on(table.nodeId),
]);

// Community Tier Manifests — published tier state snapshots
// Tier determined by coordinator polling every 15 min
export const communityTierManifests = pgTable("community_tier_manifests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tier: integer("tier").notNull(), // 1, 2, or 3
  totalGpus: integer("total_gpus").notNull(),
  totalVramGb: integer("total_vram_gb").notNull(),
  activeClusters: integer("active_clusters").notNull().default(0),
  // Model configuration for this tier
  baseModel: text("base_model").notNull(), // e.g., "Qwen3-32B", "Qwen3-Coder-80B-MoE"
  activeExperts: integer("active_experts").notNull(), // MoE experts active at this tier
  quantization: text("quantization").notNull(), // "awq", "gguf", "fp16"
  // Inference capabilities
  maxContextLength: integer("max_context_length").notNull(),
  estimatedTps: real("estimated_tps"), // tokens per second estimate
  speculativeDecodingEnabled: boolean("speculative_decoding_enabled").notNull().default(false),
  // Publishing
  ipfsCid: text("ipfs_cid"), // manifest published to IPFS
  hiveTxId: text("hive_tx_id"), // custom_json tx on Hive blockchain
  publishedAt: timestamp("published_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("tier_manifests_tier_idx").on(table.tier),
  index("tier_manifests_published_idx").on(table.publishedAt),
]);

// Inference Route Table — tracks how inference requests are routed
export const inferenceRoutes = pgTable("inference_routes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clusterId: varchar("cluster_id").references(() => gpuClusters.id), // null = local inference
  mode: text("mode").notNull(), // "local", "cluster", "hybrid"
  modelName: text("model_name").notNull(),
  // Pipeline parallel config
  pipelineStages: integer("pipeline_stages").notNull().default(1),
  tensorParallelSize: integer("tensor_parallel_size").notNull().default(1),
  // Performance tracking
  totalRequests: integer("total_requests").notNull().default(0),
  avgLatencyMs: real("avg_latency_ms"),
  avgTps: real("avg_tps"), // average tokens per second
  p99LatencyMs: real("p99_latency_ms"),
  // Status
  status: text("status").notNull().default("active"), // active, draining, inactive
  priority: integer("priority").notNull().default(0), // higher = preferred
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("inference_routes_cluster_idx").on(table.clusterId),
  index("inference_routes_mode_idx").on(table.mode),
]);

// Inference Contributions — tracks GPU time donated for community inference
export const inferenceContributions = pgTable("inference_contributions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  nodeId: varchar("node_id").notNull().references(() => computeNodes.id),
  clusterId: varchar("cluster_id").references(() => gpuClusters.id),
  // Contribution metrics
  totalTokensGenerated: bigint("total_tokens_generated", { mode: "number" }).notNull().default(0),
  totalInferenceMs: bigint("total_inference_ms", { mode: "number" }).notNull().default(0),
  totalRequestsServed: integer("total_requests_served").notNull().default(0),
  // Rewards
  hbdEarned: real("hbd_earned").notNull().default(0),
  reputationBonus: integer("reputation_bonus").notNull().default(0),
  // Period tracking
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("inference_contrib_node_idx").on(table.nodeId),
  index("inference_contrib_period_idx").on(table.periodStart),
]);

// ── Spirit Bomb Insert Schemas ──────────────────────────────────

export const insertGpuClusterSchema = createInsertSchema(gpuClusters).omit({
  id: true, createdAt: true, updatedAt: true,
});

export const insertGpuClusterMemberSchema = createInsertSchema(gpuClusterMembers).omit({
  id: true, joinedAt: true,
});

export const insertCommunityTierManifestSchema = createInsertSchema(communityTierManifests).omit({
  id: true, createdAt: true,
});

export const insertInferenceRouteSchema = createInsertSchema(inferenceRoutes).omit({
  id: true, createdAt: true, updatedAt: true,
});

export const insertInferenceContributionSchema = createInsertSchema(inferenceContributions).omit({
  id: true, createdAt: true,
});

// ============================================================
// PHASE 11: Generic Trusted-Role Registry
// ============================================================

// Trusted Role Policies — per-role configuration (seeded at startup)
export const trustedRolePolicies = pgTable("trusted_role_policies", {
  role: text("role").primaryKey(), // validator, treasury_signer, compute_verifier, oracle_runner, dbc_trainer
  vouchesRequired: integer("vouches_required").notNull().default(2),
  cooldownHours: integer("cooldown_hours").notNull().default(168), // 7 days
  maxChurnEvents: integer("max_churn_events").notNull().default(5),
  requiresOptIn: boolean("requires_opt_in").notNull().default(true),
  autoEligibleWitnessRank: integer("auto_eligible_witness_rank").notNull().default(150),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Trusted Roles — who holds what role and why
export const trustedRoles = pgTable("trusted_roles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  role: text("role").notNull().references(() => trustedRolePolicies.role),
  status: text("status").notNull().default("active"), // active, cooldown, suspended, removed
  eligibilityType: text("eligibility_type").notNull(), // witness, vouched
  witnessRank: integer("witness_rank"), // rank at time of eligibility (null if vouched)
  optedInAt: timestamp("opted_in_at"),
  cooldownUntil: timestamp("cooldown_until"),
  removedAt: timestamp("removed_at"),
  removeReason: text("remove_reason"),
  metadataJson: text("metadata_json"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trusted_roles_username_role_idx").on(table.username, table.role),
]);

// Trusted Role Vouches — unified vouching across all roles
export const trustedRoleVouches = pgTable("trusted_role_vouches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  voucherUsername: text("voucher_username").notNull(), // Top-150 witness
  candidateUsername: text("candidate_username").notNull(),
  role: text("role").notNull().references(() => trustedRolePolicies.role),
  voucherRank: integer("voucher_rank").notNull(), // Witness rank at time of vouch
  active: boolean("active").notNull().default(true),
  revokedAt: timestamp("revoked_at"),
  revokeReason: text("revoke_reason"), // manual, voucher_deranked, candidate_removed
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("trusted_role_vouches_active_idx")
    .on(table.voucherUsername, table.candidateUsername, table.role)
    .where(sql`active = true`),
]);

// Trusted Role Audit Log — all trust state changes
export const trustedRoleAuditLog = pgTable("trusted_role_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull(),
  role: text("role").notNull(),
  action: text("action").notNull(), // opted_in, opted_out, vouch_added, vouch_revoked, suspended, removed, witness_verified, witness_deranked
  actorUsername: text("actor_username"), // who performed the action (null = system)
  details: text("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Phase 11: Trusted-Role Insert Schemas
export const insertTrustedRolePolicySchema = createInsertSchema(trustedRolePolicies);

export const insertTrustedRoleSchema = createInsertSchema(trustedRoles).omit({
  id: true,
  createdAt: true,
});

export const insertTrustedRoleVouchSchema = createInsertSchema(trustedRoleVouches).omit({
  id: true,
  createdAt: true,
});

export const insertTrustedRoleAuditLogSchema = createInsertSchema(trustedRoleAuditLog).omit({
  id: true,
  createdAt: true,
});

// Phase 10: GPU Compute Insert Schemas
export const insertComputeNodeSchema = createInsertSchema(computeNodes).omit({
  id: true,
  createdAt: true,
  lastHeartbeatAt: true,
  totalJobsCompleted: true,
  totalJobsFailed: true,
  totalHbdEarned: true,
});

export const insertComputeJobSchema = createInsertSchema(computeJobs).omit({
  id: true,
  createdAt: true,
  completedAt: true,
  cancelledAt: true,
  attemptCount: true,
  acceptedAttemptId: true, // set programmatically at acceptance, never at insert
});

export const insertComputeJobAttemptSchema = createInsertSchema(computeJobAttempts).omit({
  id: true,
  createdAt: true,
});

export const insertComputeVerificationSchema = createInsertSchema(computeVerifications).omit({
  id: true,
  createdAt: true,
});

export const insertComputePayoutSchema = createInsertSchema(computePayouts).omit({
  id: true,
  createdAt: true,
});

export const insertComputeWalletSchema = createInsertSchema(computeWallets).omit({
  id: true,
  createdAt: true,
});

export const insertComputeWalletLedgerSchema = createInsertSchema(computeWalletLedger).omit({
  id: true,
  createdAt: true,
});

export const insertComputePayoutBroadcastSchema = createInsertSchema(computePayoutBroadcasts).omit({
  id: true,
  createdAt: true,
});

// Phase 2A: Challenge Protocol Insert Schemas
export const insertComputeResourceClassProfileSchema = createInsertSchema(computeResourceClassProfiles).omit({
  profileId: true,
  createdAt: true,
});

export const insertComputeChallengeStageBundle = createInsertSchema(computeChallengeStageB).omit({
  id: true,
  precomputedAt: true,
  // Runtime bind/reveal fields — set programmatically, never at insert
  jobId: true,
  attemptId: true,
  claimedAt: true,
  stageIssuedAt: true,
  stageDeadlineAt: true,
});

export const insertComputeChallengeCheckpointSchema = createInsertSchema(computeChallengeCheckpoints).omit({
  id: true,
  createdAt: true,
});

// Phase 2B: VRAM Class Evidence Insert Schema
export const insertComputeVramClassEvidenceSchema = createInsertSchema(computeVramClassEvidence).omit({
  id: true,
  createdAt: true,
});

// Phase 9: Content Moderation Insert Schemas
export const insertContentFlagSchema = createInsertSchema(contentFlags).omit({
  id: true,
  createdAt: true,
  reviewedAt: true,
});

export const insertUploaderBanSchema = createInsertSchema(uploaderBans).omit({
  id: true,
  createdAt: true,
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

// Phase 9: Content Moderation Types
export type ContentFlag = typeof contentFlags.$inferSelect;
export type InsertContentFlag = z.infer<typeof insertContentFlagSchema>;

export type UploaderBan = typeof uploaderBans.$inferSelect;
export type InsertUploaderBan = z.infer<typeof insertUploaderBanSchema>;

// Phase 7: Web of Trust
export const insertWebOfTrustSchema = createInsertSchema(webOfTrust).omit({
  id: true,
  createdAt: true,
  revokedAt: true,
});

// Phase 8: Multisig Treasury
export const insertTreasurySignerSchema = createInsertSchema(treasurySigners).omit({
  id: true,
  createdAt: true,
});

export const insertTreasuryVouchSchema = createInsertSchema(treasuryVouches).omit({
  id: true,
  createdAt: true,
  revokedAt: true,
});

export const insertTreasuryTransactionSchema = createInsertSchema(treasuryTransactions).omit({
  id: true,
  createdAt: true,
});

export const insertTreasuryAuditLogSchema = createInsertSchema(treasuryAuditLog).omit({
  id: true,
  createdAt: true,
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

// Phase 7: Web of Trust Types
export type WebOfTrust = typeof webOfTrust.$inferSelect;
export type InsertWebOfTrust = z.infer<typeof insertWebOfTrustSchema>;

// Phase 8: Multisig Treasury Types
export type TreasurySigner = typeof treasurySigners.$inferSelect;
export type InsertTreasurySigner = z.infer<typeof insertTreasurySignerSchema>;

export type TreasuryVouch = typeof treasuryVouches.$inferSelect;
export type InsertTreasuryVouch = z.infer<typeof insertTreasuryVouchSchema>;

export type TreasuryTransaction = typeof treasuryTransactions.$inferSelect;
export type InsertTreasuryTransaction = z.infer<typeof insertTreasuryTransactionSchema>;

export type TreasuryAuditLog = typeof treasuryAuditLog.$inferSelect;
export type InsertTreasuryAuditLog = z.infer<typeof insertTreasuryAuditLogSchema>;

// Phase 10: GPU Compute Marketplace Types
export type ComputeNode = typeof computeNodes.$inferSelect;
export type InsertComputeNode = z.infer<typeof insertComputeNodeSchema>;

export type ComputeJob = typeof computeJobs.$inferSelect;
export type InsertComputeJob = z.infer<typeof insertComputeJobSchema>;

export type ComputeJobAttempt = typeof computeJobAttempts.$inferSelect;
export type InsertComputeJobAttempt = z.infer<typeof insertComputeJobAttemptSchema>;

export type ComputeVerification = typeof computeVerifications.$inferSelect;
export type InsertComputeVerification = z.infer<typeof insertComputeVerificationSchema>;

export type ComputePayout = typeof computePayouts.$inferSelect;
export type InsertComputePayout = z.infer<typeof insertComputePayoutSchema>;

export type ComputeWallet = typeof computeWallets.$inferSelect;
export type InsertComputeWallet = z.infer<typeof insertComputeWalletSchema>;

export type ComputeWalletLedgerEntry = typeof computeWalletLedger.$inferSelect;
export type InsertComputeWalletLedgerEntry = z.infer<typeof insertComputeWalletLedgerSchema>;

export type ComputePayoutBroadcast = typeof computePayoutBroadcasts.$inferSelect;
export type InsertComputePayoutBroadcast = z.infer<typeof insertComputePayoutBroadcastSchema>;

// Phase 2A: Challenge Protocol Types
export type ComputeResourceClassProfile = typeof computeResourceClassProfiles.$inferSelect;
export type InsertComputeResourceClassProfile = z.infer<typeof insertComputeResourceClassProfileSchema>;

export type ComputeChallengeStageBundle = typeof computeChallengeStageB.$inferSelect;
export type InsertComputeChallengeStageBundle = z.infer<typeof insertComputeChallengeStageBundle>;

export type ComputeChallengeCheckpoint = typeof computeChallengeCheckpoints.$inferSelect;
export type InsertComputeChallengeCheckpoint = z.infer<typeof insertComputeChallengeCheckpointSchema>;

export type ComputeVramClassEvidence = typeof computeVramClassEvidence.$inferSelect;
export type InsertComputeVramClassEvidence = z.infer<typeof insertComputeVramClassEvidenceSchema>;

// Phase 11: Trusted-Role Registry Types
export type TrustedRolePolicy = typeof trustedRolePolicies.$inferSelect;
export type InsertTrustedRolePolicy = z.infer<typeof insertTrustedRolePolicySchema>;

export type TrustedRole = typeof trustedRoles.$inferSelect;
export type InsertTrustedRole = z.infer<typeof insertTrustedRoleSchema>;

export type TrustedRoleVouch = typeof trustedRoleVouches.$inferSelect;
export type InsertTrustedRoleVouch = z.infer<typeof insertTrustedRoleVouchSchema>;

export type TrustedRoleAuditEntry = typeof trustedRoleAuditLog.$inferSelect;
export type InsertTrustedRoleAuditEntry = z.infer<typeof insertTrustedRoleAuditLogSchema>;

// Spirit Bomb: Community Cloud Types
export type GpuCluster = typeof gpuClusters.$inferSelect;
export type InsertGpuCluster = z.infer<typeof insertGpuClusterSchema>;

export type GpuClusterMember = typeof gpuClusterMembers.$inferSelect;
export type InsertGpuClusterMember = z.infer<typeof insertGpuClusterMemberSchema>;

export type CommunityTierManifest = typeof communityTierManifests.$inferSelect;
export type InsertCommunityTierManifest = z.infer<typeof insertCommunityTierManifestSchema>;

export type InferenceRoute = typeof inferenceRoutes.$inferSelect;
export type InsertInferenceRoute = z.infer<typeof insertInferenceRouteSchema>;

export type InferenceContribution = typeof inferenceContributions.$inferSelect;
export type InsertInferenceContribution = z.infer<typeof insertInferenceContributionSchema>;
