/**
 * Treasury Signer — Agent-side auto-signing daemon for multisig treasury.
 *
 * Receives SigningRequest messages over the existing agent WebSocket,
 * validates against local policy rules, signs with the active key,
 * and returns a SigningResponse. No popups, no user interaction for
 * routine payments. Authority updates also auto-sign if policy allows.
 *
 * Security hardening:
 *   - Protocol version validation
 *   - Nonce replay protection (rejects duplicate nonces)
 *   - Operations ↔ tx.operations cross-verification
 *   - Daily spend persisted to disk (survives restarts)
 *   - Policy updates only from local config (no remote override)
 */

import { cryptoUtils } from "@hiveio/dhive";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ConfigStore } from "./config";
import { WalletManager } from "./wallet-manager";

// Hive mainnet chain ID — used to verify transaction digests locally
const HIVE_CHAIN_ID = Buffer.from(
  "beeab0de00000000000000000000000000000000000000000000000000000000",
  "hex",
);
import type {
  SigningRequest,
  SigningResponse,
  TreasurySignerConfig,
} from "../../../shared/treasury-types";
import {
  DEFAULT_SIGNER_CONFIG,
  TREASURY_PROTOCOL_VERSION,
  MAX_OPS_PER_TRANSACTION,
  MAX_BATCH_TOTAL_HBD,
} from "../../../shared/treasury-types";

/** Maximum nonces to track before evicting oldest 20% */
const MAX_NONCE_CACHE = 10_000;

interface PersistedSpendState {
  dailySpendHbd: number;
  dailySpendResetAt: number;
}

export class TreasurySigner {
  private config: ConfigStore;
  private wallet: WalletManager;
  private policyConfig: TreasurySignerConfig;

  // Daily spend tracking (persisted to disk)
  private dailySpendHbd = 0;
  private dailySpendResetAt = Date.now() + 86_400_000;
  private spendFilePath: string;

  // Nonce replay protection — reject duplicate nonces
  private seenNonces = new Map<string, number>(); // nonce → timestamp

  // Rate limiting
  private signingRequestTimestamps: number[] = [];

  constructor(config: ConfigStore, wallet: WalletManager, dataDir?: string) {
    this.config = config;
    this.wallet = wallet;
    this.policyConfig = { ...DEFAULT_SIGNER_CONFIG };

    // Persist daily spend to disk so restarts don't reset the daily cap
    const dir = dataDir || (typeof process !== "undefined" ? process.cwd() : ".");
    this.spendFilePath = join(dir, "treasury-spend-state.json");
    this.loadSpendState();
  }

  /**
   * Handle an incoming signing request. Returns a SigningResponse to send back.
   */
  async handleSigningRequest(request: SigningRequest): Promise<SigningResponse> {
    const agentConfig = this.config.getConfig();
    const signerUsername = agentConfig.hiveUsername || "";

    // Check if treasury signing is enabled
    if (!agentConfig.treasurySignerEnabled) {
      return this.reject(request.txId, request.nonce, signerUsername, "treasury_signer_disabled");
    }

    // Check if wallet has an active key
    if (!this.wallet.hasActiveKey()) {
      return this.reject(request.txId, request.nonce, signerUsername, "no_active_key");
    }

    // SECURITY: Validate protocol version
    if (request.version !== TREASURY_PROTOCOL_VERSION) {
      return this.reject(request.txId, request.nonce, signerUsername,
        `unsupported_protocol_version:${request.version}`);
    }

    // SECURITY: Reject duplicate nonces (replay protection)
    if (!request.nonce || this.seenNonces.has(request.nonce)) {
      return this.reject(request.txId, request.nonce, signerUsername, "duplicate_or_missing_nonce");
    }
    this.trackNonce(request.nonce);

    // Check expiration
    if (new Date(request.expiresAt).getTime() < Date.now()) {
      return this.reject(request.txId, request.nonce, signerUsername, "request_expired");
    }

    // Run policy checks
    const policyResult = this.checkPolicy(request);
    if (!policyResult.allowed) {
      console.log(`[TreasurySigner] Policy rejected: ${policyResult.reason}`);
      return this.reject(request.txId, request.nonce, signerUsername, policyResult.reason);
    }

    // SECURITY: Verify the digest matches the tx object before signing.
    try {
      if (!request.tx) {
        return this.reject(request.txId, request.nonce, signerUsername, "missing_tx_object");
      }

      // SECURITY: Verify operations array matches tx.operations exactly.
      // Prevents a compromised server from sending benign-looking operations
      // for policy approval but a tx with different actual operations.
      if (!this.verifyOperationsMatch(request.operations, request.tx.operations)) {
        console.error(`[TreasurySigner] OPERATIONS MISMATCH — request.operations != tx.operations!`);
        return this.reject(request.txId, request.nonce, signerUsername, "operations_mismatch");
      }

      // Compute digest locally from the full tx to verify it matches
      const localDigest = (cryptoUtils as any).transactionDigest(
        request.tx,
        HIVE_CHAIN_ID,
      );
      const localDigestHex = localDigest.toString("hex");
      if (localDigestHex !== request.txDigest) {
        console.error(`[TreasurySigner] DIGEST MISMATCH — server sent tampered digest!`);
        return this.reject(request.txId, request.nonce, signerUsername, "digest_mismatch");
      }

      // Sign using the wallet manager (key never exposed as raw string)
      const signature = this.wallet.signDigest(request.txDigest);
      if (!signature) {
        return this.reject(request.txId, request.nonce, signerUsername, "signing_failed");
      }

      // Track daily spend for transfers (sum all transfer ops in the tx)
      if (request.metadata.txType === "transfer") {
        for (const op of request.operations) {
          const opType = Array.isArray(op) ? op[0] : op.type;
          if (opType === "transfer") {
            const opData = Array.isArray(op) ? op[1] : op;
            const amount = parseFloat(opData.amount || "0");
            if (!isNaN(amount)) {
              this.dailySpendHbd += amount;
            }
          }
        }
        this.saveSpendState();
      }

      console.log(`[TreasurySigner] Signed tx ${request.txId} (${request.metadata.txType})`);

      return {
        type: "SigningResponse",
        version: TREASURY_PROTOCOL_VERSION,
        txId: request.txId,
        nonce: request.nonce,
        signerUsername,
        signature,
        rejected: false,
        rejectReason: null,
      };
    } catch (err: any) {
      console.error(`[TreasurySigner] Signing failed: ${err.message}`);
      return this.reject(request.txId, request.nonce, signerUsername, "signing_error");
    }
  }

  /**
   * SECURITY: Verify that request.operations matches tx.operations exactly.
   * Deep comparison using JSON serialization — operations must be identical.
   */
  private verifyOperationsMatch(policyOps: any[], txOps: any[]): boolean {
    if (!policyOps || !txOps) return false;
    if (policyOps.length !== txOps.length) return false;
    try {
      return JSON.stringify(policyOps) === JSON.stringify(txOps);
    } catch {
      return false;
    }
  }

  /**
   * Local policy engine. Validates requests before signing.
   */
  private checkPolicy(request: SigningRequest): { allowed: boolean; reason: string } {
    // Reset daily spend counter if day has passed
    if (Date.now() > this.dailySpendResetAt) {
      this.dailySpendHbd = 0;
      this.dailySpendResetAt = Date.now() + 86_400_000;
      this.saveSpendState();
    }

    // Rate limit check
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    this.signingRequestTimestamps = this.signingRequestTimestamps.filter((t) => t > oneHourAgo);
    if (this.signingRequestTimestamps.length >= this.policyConfig.maxSigningRequestsPerHour) {
      return { allowed: false, reason: "rate_limit_exceeded" };
    }
    this.signingRequestTimestamps.push(now);

    // Batch operation limits
    if (request.operations.length > MAX_OPS_PER_TRANSACTION) {
      return { allowed: false, reason: `too_many_operations:${request.operations.length}>${MAX_OPS_PER_TRANSACTION}` };
    }

    // Operation type whitelist
    for (const op of request.operations) {
      const opType = Array.isArray(op) ? op[0] : op.type;
      if (!["transfer", "account_update"].includes(opType)) {
        return { allowed: false, reason: `blocked_op_type:${opType}` };
      }
    }

    // Transfer-specific checks: verify each individual transfer operation
    if (request.metadata.txType === "transfer") {
      let totalAmount = 0;
      for (const op of request.operations) {
        const opType = Array.isArray(op) ? op[0] : op.type;
        if (opType === "transfer") {
          const opData = Array.isArray(op) ? op[1] : op;
          const opAmount = parseFloat(opData.amount || "0");
          // Per-transfer cap (each individual transfer, not the batch total)
          if (opAmount > this.policyConfig.maxPerTxHbd) {
            return { allowed: false, reason: `amount_exceeds_cap:${opAmount}>${this.policyConfig.maxPerTxHbd}` };
          }
          totalAmount += opAmount;
        }
      }

      // Batch total HBD limit
      if (totalAmount > MAX_BATCH_TOTAL_HBD) {
        return { allowed: false, reason: `batch_total_exceeds_cap:${totalAmount}>${MAX_BATCH_TOTAL_HBD}` };
      }

      // Daily cap against batch total
      if (totalAmount > 0 && this.dailySpendHbd + totalAmount > this.policyConfig.dailyCapHbd) {
        return { allowed: false, reason: `daily_cap_exceeded:${this.dailySpendHbd + totalAmount}>${this.policyConfig.dailyCapHbd}` };
      }
    }

    return { allowed: true, reason: "" };
  }

  private reject(txId: string, nonce: string, signerUsername: string, reason: string): SigningResponse {
    return {
      type: "SigningResponse",
      version: TREASURY_PROTOCOL_VERSION,
      txId,
      nonce,
      signerUsername,
      signature: null,
      rejected: true,
      rejectReason: reason,
    };
  }

  /** Track a nonce to prevent replay. Evicts oldest 20% when cache is full. */
  private trackNonce(nonce: string): void {
    if (this.seenNonces.size >= MAX_NONCE_CACHE) {
      // Evict oldest 20%
      const entries = [...this.seenNonces.entries()]
        .sort((a, b) => a[1] - b[1]);
      const toRemove = Math.ceil(MAX_NONCE_CACHE * 0.2);
      for (let i = 0; i < toRemove; i++) {
        this.seenNonces.delete(entries[i][0]);
      }
    }
    this.seenNonces.set(nonce, Date.now());
  }

  /** Persist daily spend state to disk so restarts don't reset the cap. */
  private saveSpendState(): void {
    try {
      const state: PersistedSpendState = {
        dailySpendHbd: this.dailySpendHbd,
        dailySpendResetAt: this.dailySpendResetAt,
      };
      writeFileSync(this.spendFilePath, JSON.stringify(state), "utf-8");
    } catch {
      // Non-critical — worst case we lose spend tracking on crash
    }
  }

  /** Load persisted daily spend state from disk. */
  private loadSpendState(): void {
    try {
      if (existsSync(this.spendFilePath)) {
        const raw = readFileSync(this.spendFilePath, "utf-8");
        const state: PersistedSpendState = JSON.parse(raw);
        if (state.dailySpendResetAt > Date.now()) {
          this.dailySpendHbd = state.dailySpendHbd;
          this.dailySpendResetAt = state.dailySpendResetAt;
        }
        // If reset time has passed, leave defaults (0 spend, new 24h window)
      }
    } catch {
      // Non-critical — start fresh
    }
  }

  /**
   * Check if this agent is ready to sign treasury transactions.
   */
  isReady(): boolean {
    const cfg = this.config.getConfig();
    return cfg.treasurySignerEnabled && this.wallet.hasActiveKey();
  }

  getStatus(): {
    enabled: boolean;
    hasActiveKey: boolean;
    dailySpendHbd: number;
    policyConfig: TreasurySignerConfig;
  } {
    return {
      enabled: this.config.getConfig().treasurySignerEnabled,
      hasActiveKey: this.wallet.hasActiveKey(),
      dailySpendHbd: this.dailySpendHbd,
      policyConfig: this.policyConfig,
    };
  }
}
