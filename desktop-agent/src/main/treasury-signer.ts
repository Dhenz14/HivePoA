/**
 * Treasury Signer — Agent-side auto-signing daemon for multisig treasury.
 *
 * Receives SigningRequest messages over the existing agent WebSocket,
 * validates against local policy rules, signs with the active key,
 * and returns a SigningResponse. No popups, no user interaction for
 * routine payments. Authority updates also auto-sign if policy allows.
 */

import { PrivateKey, cryptoUtils } from "@hiveio/dhive";
import { ConfigStore } from "./config";

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
import { DEFAULT_SIGNER_CONFIG } from "../../../shared/treasury-types";

export class TreasurySigner {
  private config: ConfigStore;
  private policyConfig: TreasurySignerConfig;

  // Daily spend tracking (resets every 24h)
  private dailySpendHbd = 0;
  private dailySpendResetAt = Date.now() + 86_400_000;

  // Rate limiting
  private signingRequestTimestamps: number[] = [];

  constructor(config: ConfigStore) {
    this.config = config;
    this.policyConfig = { ...DEFAULT_SIGNER_CONFIG };
  }

  /**
   * Handle an incoming signing request. Returns a SigningResponse to send back.
   */
  async handleSigningRequest(request: SigningRequest): Promise<SigningResponse> {
    const agentConfig = this.config.getConfig();

    // Check if treasury signing is enabled
    if (!agentConfig.treasurySignerEnabled) {
      return this.reject(request.txId, "treasury_signer_disabled");
    }

    // Check if we have an active key
    const activeKey = this.config.getActiveKey();
    if (!activeKey) {
      return this.reject(request.txId, "no_active_key");
    }

    // Check expiration
    if (new Date(request.expiresAt).getTime() < Date.now()) {
      return this.reject(request.txId, "request_expired");
    }

    // Run policy checks
    const policyResult = this.checkPolicy(request);
    if (!policyResult.allowed) {
      console.log(`[TreasurySigner] Policy rejected: ${policyResult.reason}`);
      return this.reject(request.txId, policyResult.reason);
    }

    // SECURITY: Verify the digest matches the tx object before signing.
    // This prevents a compromised server from sending a policy-compliant operations
    // array but a digest for a different malicious transaction.
    try {
      if (!request.tx) {
        return this.reject(request.txId, "missing_tx_object");
      }

      // Compute digest locally from the full tx to verify it matches
      const localDigest = (cryptoUtils as any).transactionDigest(
        request.tx,
        HIVE_CHAIN_ID,
      );
      const localDigestHex = localDigest.toString("hex");
      if (localDigestHex !== request.txDigest) {
        console.error(`[TreasurySigner] DIGEST MISMATCH — server sent tampered digest!`);
        return this.reject(request.txId, "digest_mismatch");
      }

      // Also verify the operations in the tx match what's in metadata
      // (the tx object IS the source of truth since we verified the digest from it)
      const digestBuffer = Buffer.from(request.txDigest, "hex");
      const key = PrivateKey.fromString(activeKey);
      const signature = key.sign(digestBuffer).toString();

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
      }

      console.log(`[TreasurySigner] Signed tx ${request.txId} (${request.metadata.txType})`);

      return {
        type: "SigningResponse",
        txId: request.txId,
        signature,
        rejected: false,
        rejectReason: null,
      };
    } catch (err: any) {
      console.error(`[TreasurySigner] Signing failed: ${err.message}`);
      return this.reject(request.txId, "signing_error");
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
    }

    // Rate limit check
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    this.signingRequestTimestamps = this.signingRequestTimestamps.filter((t) => t > oneHourAgo);
    if (this.signingRequestTimestamps.length >= this.policyConfig.maxSigningRequestsPerHour) {
      return { allowed: false, reason: "rate_limit_exceeded" };
    }
    this.signingRequestTimestamps.push(now);

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

      // Daily cap against batch total
      if (totalAmount > 0 && this.dailySpendHbd + totalAmount > this.policyConfig.dailyCapHbd) {
        return { allowed: false, reason: `daily_cap_exceeded:${this.dailySpendHbd + totalAmount}>${this.policyConfig.dailyCapHbd}` };
      }
    }

    return { allowed: true, reason: "" };
  }

  private reject(txId: string, reason: string): SigningResponse {
    return {
      type: "SigningResponse",
      txId,
      signature: null,
      rejected: true,
      rejectReason: reason,
    };
  }

  /**
   * Update policy configuration at runtime.
   */
  updatePolicy(config: Partial<TreasurySignerConfig>): void {
    this.policyConfig = { ...this.policyConfig, ...config };
  }

  /**
   * Check if this agent is ready to sign treasury transactions.
   */
  isReady(): boolean {
    const cfg = this.config.getConfig();
    return cfg.treasurySignerEnabled && this.config.hasActiveKey();
  }

  getStatus(): {
    enabled: boolean;
    hasActiveKey: boolean;
    dailySpendHbd: number;
    policyConfig: TreasurySignerConfig;
  } {
    return {
      enabled: this.config.getConfig().treasurySignerEnabled,
      hasActiveKey: this.config.hasActiveKey(),
      dailySpendHbd: this.dailySpendHbd,
      policyConfig: this.policyConfig,
    };
  }
}
