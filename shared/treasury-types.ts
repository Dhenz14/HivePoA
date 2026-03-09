/**
 * Shared TypeScript interfaces for the Multisig Treasury system.
 * Used by both server (coordinator) and desktop agent (signer).
 */

// ============================================================
// WebSocket Message Types (Server <-> Agent)
// ============================================================

/** Server -> Agent: Request to sign a treasury transaction */
export interface SigningRequest {
  type: "SigningRequest";
  version: number;                 // Protocol version (must be 1)
  txId: string;                    // treasury_transactions.id
  nonce: string;                   // Unique nonce — agent rejects duplicates
  txDigest: string;                // Hex SHA256 of serialized tx — what gets signed
  operations: any[];               // Human-readable ops for agent-side policy check
  tx: any;                         // Full unsigned tx object — agent verifies digest matches
  expiresAt: string;               // ISO8601
  metadata: SigningMetadata;
}

/** Agent -> Server: Response to a signing request */
export interface SigningResponse {
  type: "SigningResponse";
  version: number;                 // Protocol version (must be 1)
  txId: string;
  nonce: string;                   // Echo back nonce for replay matching
  signature: string | null;        // Hex signature, or null if rejected
  rejected: boolean;
  rejectReason: string | null;     // e.g., "amount_exceeds_cap", "blocked_op_type"
  signerUsername: string;           // Signer's Hive username for server-side verification
}

/** Current protocol version */
export const TREASURY_PROTOCOL_VERSION = 1;

/** Metadata attached to signing requests for policy decisions */
export interface SigningMetadata {
  txType: "transfer" | "authority_update";
  recipient?: string;
  amount?: string;                 // e.g., "0.150 HBD"
  memo?: string;
}

// ============================================================
// Treasury Status (API responses)
// ============================================================

export interface TreasuryStatus {
  operational: boolean;            // true if 3+ signers online and authority in sync
  signerCount: number;
  onlineSignerCount: number;
  threshold: number;               // ceil(signerCount * 0.6)
  authorityThreshold: number;      // ceil(signerCount * 0.8) — higher quorum for authority updates
  treasuryAccount: string;         // e.g., "@hivepoa-treasury"
  balance?: string;                // Current HBD balance
  authorityInSync: boolean;        // On-chain authority matches DB signer set
  frozen: boolean;                 // Emergency freeze active
  frozenBy?: string;               // Who triggered the freeze
  frozenAt?: string;               // ISO8601 when frozen
  unfreezeVotes?: number;          // Current unfreeze vote count
  unfreezeThreshold?: number;      // Votes needed to unfreeze (80%)
}

export interface TreasurySignerInfo {
  username: string;
  status: string;
  weight: number;
  joinedAt: string | null;
  lastHeartbeat: string | null;
  online: boolean;                 // WebSocket connected right now
  vouchCount?: number;             // Number of active WoT vouches (for non-witnesses)
}

// ============================================================
// Agent-Side Policy Configuration
// ============================================================

export interface TreasurySignerConfig {
  enabled: boolean;
  maxPerTxHbd: number;             // Per-transaction cap (default: 1.0)
  dailyCapHbd: number;             // Daily spending cap (default: 50.0)
  maxSigningRequestsPerHour: number; // Rate limit (default: 100)
}

export const DEFAULT_SIGNER_CONFIG: TreasurySignerConfig = {
  enabled: true,
  maxPerTxHbd: 1.0,
  dailyCapHbd: 50.0,
  maxSigningRequestsPerHour: 100,
};

// ============================================================
// Constants
// ============================================================

/** Minimum active signers before treasury accepts payment routing */
export const MIN_SIGNERS_FOR_OPERATION = 3;

/** Threshold ratio — 60% of active signers must sign (transfers) */
export const THRESHOLD_RATIO = 0.6;

/** Higher threshold for authority updates — 80% quorum */
export const AUTHORITY_UPDATE_THRESHOLD_RATIO = 0.8;

/** Treasury account on Hive */
export const TREASURY_ACCOUNT = "hivepoa-treasury";

/** Signing request timeout in ms (Hive txs expire ~60s, we use 45s) */
export const SIGNING_TIMEOUT_MS = 45_000;

/** Cooldown after opting out before rejoining (7 days) */
export const OPT_OUT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Extended cooldown for churners (30 days) */
export const CHURN_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Number of opt-out events in 90 days that triggers extended cooldown */
export const CHURN_THRESHOLD = 3;

/** Rolling window for churn detection (90 days) */
export const CHURN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Minimum WoT vouches required for non-witness treasury signers */
export const MIN_TREASURY_VOUCHES = 3;

/** Self-healing authority sync interval (10 minutes) */
export const AUTHORITY_SYNC_INTERVAL_MS = 10 * 60 * 1000;

/** Maximum operations per transaction (batch limit) */
export const MAX_OPS_PER_TRANSACTION = 10;

/** Maximum total HBD per batch transaction */
export const MAX_BATCH_TOTAL_HBD = 10.0;

/** Minimum reputation for a recipient to receive treasury payments */
export const MIN_RECIPIENT_REPUTATION = 10;

/** Transfers at or below this amount broadcast immediately; above triggers delay */
export const IMMEDIATE_BROADCAST_MAX_HBD = 1.0;

/** Delay for high-value transfers (1 hour) */
export const TRANSFER_DELAY_SECONDS = 3600;

/** Delay for authority updates (6 hours) */
export const AUTHORITY_UPDATE_DELAY_SECONDS = 21600;
