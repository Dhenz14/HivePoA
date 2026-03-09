/**
 * Treasury Coordinator — The brain of the multisig treasury system.
 *
 * Manages signer lifecycle (join/leave/cooldown/derank detection),
 * builds unsigned transactions, distributes signing requests via WebSocket,
 * collects signatures, broadcasts when threshold met, and self-heals
 * the on-chain authority when signers change.
 */

import { Client } from "@hiveio/dhive";
import { storage } from "../storage";
import { logHive } from "../logger";
import {
  buildUnsignedTransaction,
  buildTransferOp,
  buildAuthorityUpdateOp,
  assembleSignedTransaction,
  broadcastMultisig,
  readOnChainAuthority,
  readAccountInfo,
  authorityMatchesSigners,
  computeThreshold,
  getTreasuryBalance,
} from "./treasury-hive";
import type { TreasurySigner } from "@shared/schema";
import {
  MIN_SIGNERS_FOR_OPERATION,
  SIGNING_TIMEOUT_MS,
  OPT_OUT_COOLDOWN_MS,
  CHURN_COOLDOWN_MS,
  CHURN_THRESHOLD,
  CHURN_WINDOW_MS,
  TREASURY_ACCOUNT,
  AUTHORITY_SYNC_INTERVAL_MS,
  MIN_TREASURY_VOUCHES,
} from "../../shared/treasury-types";
import type { SigningRequest, SigningMetadata, TreasuryStatus, TreasurySignerInfo } from "../../shared/treasury-types";
import { TREASURY_PROTOCOL_VERSION } from "../../shared/treasury-types";
import { randomUUID } from "crypto";
import { cryptoUtils, PublicKey, Signature } from "@hiveio/dhive";

const log = logHive; // Reuse the Hive logger

/** Callback type for sending WebSocket messages to connected agents */
type SendToSignerFn = (username: string, message: any) => boolean;
type GetConnectedSignersFn = () => string[];
type IsTopWitnessFn = (username: string) => Promise<boolean>;

export class TreasuryCoordinator {
  private client: Client;
  private sendToSigner: SendToSignerFn;
  private getConnectedSigners: GetConnectedSignersFn;
  private isTopWitness: IsTopWitnessFn;
  private authoritySyncTimer: NodeJS.Timeout | null = null;
  private authorityInSync = false;
  private genesisKey: string | null;

  // In-flight signing sessions: txId -> { resolve, timeout }
  private pendingSigningSessions: Map<string, {
    resolve: (result: { success: boolean; txId?: string }) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  // Guard against concurrent broadcast attempts for the same tx
  private broadcastingTxIds: Set<string> = new Set();

  // Nonce tracking: prevent replay attacks (nonce -> txId)
  private usedNonces: Map<string, string> = new Map();
  private static readonly MAX_NONCE_CACHE = 10000;

  // Server-side per-tx amount cap (defense-in-depth, mirrors agent policy)
  private static readonly SERVER_MAX_PER_TX_HBD = 5.0;
  private static readonly SERVER_DAILY_CAP_HBD = 200.0;
  private dailyServerSpendHbd = 0;
  private dailyServerResetAt = Date.now() + 86_400_000;

  constructor(opts: {
    client: Client;
    sendToSigner: SendToSignerFn;
    getConnectedSigners: GetConnectedSignersFn;
    isTopWitness: IsTopWitnessFn;
    genesisKey?: string;
  }) {
    this.client = opts.client;
    this.sendToSigner = opts.sendToSigner;
    this.getConnectedSigners = opts.getConnectedSigners;
    this.isTopWitness = opts.isTopWitness;
    this.genesisKey = opts.genesisKey || null;
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  start(): void {
    log.info("[Treasury] Coordinator started");
    // Run authority sync immediately, then on interval
    this.syncAuthority().catch((err) =>
      log.error({ err }, "[Treasury] Initial authority sync failed"),
    );
    this.authoritySyncTimer = setInterval(
      () => this.syncAuthority().catch((err) =>
        log.error({ err }, "[Treasury] Authority sync failed"),
      ),
      AUTHORITY_SYNC_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.authoritySyncTimer) {
      clearInterval(this.authoritySyncTimer);
      this.authoritySyncTimer = null;
    }
    // Expire all pending signing sessions
    for (const [txId, session] of Array.from(this.pendingSigningSessions)) {
      clearTimeout(session.timeout);
      session.resolve({ success: false });
      this.pendingSigningSessions.delete(txId);
    }
    log.info("[Treasury] Coordinator stopped");
  }

  // ============================================================
  // Operational Gate
  // ============================================================

  /**
   * Returns true if the treasury is ready to process payments.
   * Checked by poa-engine before routing payments through treasury.
   * Requires: TREASURY_ENABLED + authority in sync + enough online signers to meet threshold.
   */
  isOperational(): boolean {
    if (!process.env.TREASURY_ENABLED) return false;
    if (!this.authorityInSync) return false;
    // Check we have enough connected agents to potentially meet threshold
    const connectedSigners = this.getConnectedSigners();
    return connectedSigners.length >= MIN_SIGNERS_FOR_OPERATION;
  }

  async getStatus(): Promise<TreasuryStatus> {
    const signers = await storage.getActiveTreasurySigners();
    const connectedSigners = this.getConnectedSigners();
    const onlineSigners = signers.filter(
      (s) => connectedSigners.includes(s.username),
    );

    let balance: string | undefined;
    try {
      balance = await getTreasuryBalance(this.client);
    } catch {
      // Ignore — Hive API may be unreachable
    }

    return {
      operational: this.isOperational(),
      signerCount: signers.length,
      onlineSignerCount: onlineSigners.length,
      threshold: computeThreshold(signers.length),
      treasuryAccount: `@${TREASURY_ACCOUNT}`,
      balance,
      authorityInSync: this.authorityInSync,
    };
  }

  async getSignerInfoList(): Promise<TreasurySignerInfo[]> {
    const signers = await storage.getActiveTreasurySigners();
    const connectedSigners = this.getConnectedSigners();

    const result: TreasurySignerInfo[] = [];
    for (const s of signers) {
      const vouchCount = await storage.countActiveVouchesForCandidate(s.username);
      result.push({
        username: s.username,
        status: s.status,
        weight: s.weight,
        joinedAt: s.joinedAt?.toISOString() || null,
        lastHeartbeat: s.lastHeartbeat?.toISOString() || null,
        online: connectedSigners.includes(s.username),
        vouchCount,
      });
    }
    return result;
  }

  // ============================================================
  // Signer Join / Leave
  // ============================================================

  /**
   * A top-150 witness or WoT-vouched user joins the treasury signer set.
   */
  async joinSigner(username: string): Promise<{ success: boolean; error?: string }> {
    // Check if top-150 witness
    const isWitness = await this.isTopWitness(username);

    if (!isWitness) {
      // Not a witness — check WoT vouches
      const vouchCount = await storage.countActiveVouchesForCandidate(username);
      if (vouchCount < MIN_TREASURY_VOUCHES) {
        return {
          success: false,
          error: `Not a top-150 witness and only ${vouchCount}/${MIN_TREASURY_VOUCHES} treasury vouches`,
        };
      }
    }

    // Check for existing signer record
    const existing = await storage.getTreasurySignerByUsername(username);
    if (existing) {
      if (existing.status === "active") {
        return { success: false, error: "Already an active treasury signer" };
      }

      // Check cooldown
      if (existing.status === "cooldown" && existing.cooldownUntil) {
        const cooldownEnd = new Date(existing.cooldownUntil).getTime();
        if (Date.now() < cooldownEnd) {
          const daysLeft = Math.ceil((cooldownEnd - Date.now()) / (24 * 60 * 60 * 1000));
          return { success: false, error: `In cooldown. ${daysLeft} day(s) remaining.` };
        }
      }

      // Re-activate
      await storage.updateSignerStatus(username, "active", {
        joinedAt: new Date(),
        leftAt: null,
        cooldownUntil: null,
      } as any);
    } else {
      // Create new signer
      await storage.createTreasurySigner({
        username,
        status: "active",
        weight: 1,
        joinedAt: new Date(),
        optEvents: 0,
      });
    }

    log.info({ username }, "[Treasury] Signer joined");

    // Trigger authority update (async, don't block the join response)
    this.initiateAuthorityUpdate().catch((err) =>
      log.error({ err }, "[Treasury] Authority update after join failed"),
    );

    return { success: true };
  }

  /**
   * A signer opts out of the treasury.
   */
  async leaveSigner(username: string): Promise<{ success: boolean; error?: string }> {
    const signer = await storage.getTreasurySignerByUsername(username);
    if (!signer || signer.status !== "active") {
      return { success: false, error: "Not an active treasury signer" };
    }

    // Determine cooldown duration based on churn
    const newOptEvents = signer.optEvents + 1;
    const cooldownMs = newOptEvents > CHURN_THRESHOLD
      ? CHURN_COOLDOWN_MS
      : OPT_OUT_COOLDOWN_MS;

    await storage.updateSignerStatus(username, "cooldown", {
      leftAt: new Date(),
      cooldownUntil: new Date(Date.now() + cooldownMs),
      optEvents: newOptEvents,
    } as any);

    log.info({ username, cooldownDays: cooldownMs / (24 * 60 * 60 * 1000) },
      "[Treasury] Signer left, cooldown applied");

    // Trigger authority update
    this.initiateAuthorityUpdate().catch((err) =>
      log.error({ err }, "[Treasury] Authority update after leave failed"),
    );

    return { success: true };
  }

  // ============================================================
  // Payment Submission (called by poa-engine)
  // ============================================================

  /**
   * Submit a transfer for multisig signing and broadcast.
   * Returns when the transaction is broadcast or times out.
   */
  async submitTransfer(opts: {
    to: string;
    amount: string;
    memo: string;
  }): Promise<{ success: boolean; txId?: string }> {
    const signers = await storage.getActiveTreasurySigners();
    if (signers.length < MIN_SIGNERS_FOR_OPERATION) {
      log.warn("[Treasury] Not enough signers for transfer");
      return { success: false };
    }

    const threshold = computeThreshold(signers.length);

    // SERVER-SIDE policy check (defense-in-depth — mirrors agent-side caps)
    const transferAmountHbd = parseFloat(opts.amount) || 0;
    if (transferAmountHbd > TreasuryCoordinator.SERVER_MAX_PER_TX_HBD) {
      log.warn({ amount: opts.amount }, "[Treasury] Transfer exceeds server per-tx cap");
      return { success: false };
    }
    if (Date.now() > this.dailyServerResetAt) {
      this.dailyServerSpendHbd = 0;
      this.dailyServerResetAt = Date.now() + 86_400_000;
    }
    if (this.dailyServerSpendHbd + transferAmountHbd > TreasuryCoordinator.SERVER_DAILY_CAP_HBD) {
      log.warn("[Treasury] Transfer exceeds server daily cap");
      return { success: false };
    }

    const transferOp = buildTransferOp(opts.to, opts.amount, opts.memo);

    try {
      const { tx, digest } = await buildUnsignedTransaction(this.client, [transferOp]);
      const digestHex = digest.toString("hex");

      // Store the FULL transaction (not just operations) so we can reconstruct
      // the exact same tx for broadcast — chain props change between build and broadcast
      const txRecord = await storage.createTreasuryTransaction({
        txType: "transfer",
        status: "signing",
        operationsJson: JSON.stringify(tx),
        txDigest: digestHex,
        signatures: {},
        threshold,
        expiresAt: new Date(Date.now() + SIGNING_TIMEOUT_MS),
        initiatedBy: "system",
        metadata: {
          recipient: opts.to,
          amount: opts.amount,
          memo: opts.memo,
        },
      });

      // Distribute signing request to connected signers
      // Include full tx so agents can independently verify the digest
      const nonce = randomUUID();
      this.trackNonce(nonce, txRecord.id);

      const request: SigningRequest = {
        type: "SigningRequest",
        version: TREASURY_PROTOCOL_VERSION,
        txId: txRecord.id,
        nonce,
        txDigest: digestHex,
        operations: tx.operations,
        tx,
        expiresAt: new Date(Date.now() + SIGNING_TIMEOUT_MS).toISOString(),
        metadata: {
          txType: "transfer",
          recipient: opts.to,
          amount: opts.amount,
          memo: opts.memo,
        },
      };

      // Track server spend after successful request creation
      this.dailyServerSpendHbd += transferAmountHbd;

      const connectedSigners = this.getConnectedSigners();
      const activeSignerUsernames = signers.map((s) => s.username);
      let sentCount = 0;

      for (const username of activeSignerUsernames) {
        if (connectedSigners.includes(username)) {
          if (this.sendToSigner(username, request)) {
            sentCount++;
          }
        }
      }

      log.info(
        { txId: txRecord.id, sentTo: sentCount, threshold },
        "[Treasury] Signing request distributed",
      );

      if (sentCount < threshold) {
        log.warn(
          { sentCount, threshold },
          "[Treasury] Not enough online signers for threshold",
        );
        await storage.updateTreasuryTxStatus(txRecord.id, "failed");
        return { success: false };
      }

      // Wait for signatures to be collected (resolved by handleSigningResponse)
      return await new Promise<{ success: boolean; txId?: string }>((resolve) => {
        const timeout = setTimeout(async () => {
          this.pendingSigningSessions.delete(txRecord.id);
          await storage.updateTreasuryTxStatus(txRecord.id, "expired");
          log.warn({ txId: txRecord.id }, "[Treasury] Signing request expired");
          resolve({ success: false });
        }, SIGNING_TIMEOUT_MS);

        this.pendingSigningSessions.set(txRecord.id, { resolve, timeout });
      });
    } catch (err) {
      log.error({ err }, "[Treasury] Failed to submit transfer");
      return { success: false };
    }
  }

  /**
   * Submit multiple transfers in a single multisig transaction.
   * Reduces signing rounds — one Hive tx can carry many operations.
   */
  async submitBatchTransfer(payments: {
    to: string;
    amount: string;
    memo: string;
  }[]): Promise<{ success: boolean; txId?: string }> {
    if (payments.length === 0) return { success: false };

    const signers = await storage.getActiveTreasurySigners();
    if (signers.length < MIN_SIGNERS_FOR_OPERATION) {
      log.warn("[Treasury] Not enough signers for batch transfer");
      return { success: false };
    }

    const threshold = computeThreshold(signers.length);
    const transferOps = payments.map((p) => buildTransferOp(p.to, p.amount, p.memo));

    try {
      const { tx, digest } = await buildUnsignedTransaction(this.client, transferOps);
      const digestHex = digest.toString("hex");

      const totalAmount = payments
        .map((p) => parseFloat(p.amount))
        .reduce((sum, a) => sum + a, 0)
        .toFixed(3);

      const txRecord = await storage.createTreasuryTransaction({
        txType: "transfer",
        status: "signing",
        operationsJson: JSON.stringify(tx),
        txDigest: digestHex,
        signatures: {},
        threshold,
        expiresAt: new Date(Date.now() + SIGNING_TIMEOUT_MS),
        initiatedBy: "system",
        metadata: {
          batchSize: payments.length,
          totalAmount: `${totalAmount} HBD`,
          recipients: payments.map((p) => p.to),
        },
      });

      const batchNonce = randomUUID();
      this.trackNonce(batchNonce, txRecord.id);

      const request: SigningRequest = {
        type: "SigningRequest",
        version: TREASURY_PROTOCOL_VERSION,
        txId: txRecord.id,
        nonce: batchNonce,
        txDigest: digestHex,
        operations: tx.operations,
        tx,
        expiresAt: new Date(Date.now() + SIGNING_TIMEOUT_MS).toISOString(),
        metadata: {
          txType: "transfer",
          amount: `${totalAmount} HBD`,
          memo: `Batch: ${payments.length} payments`,
        },
      };

      const connectedSigners = this.getConnectedSigners();
      const activeSignerUsernames = signers.map((s) => s.username);
      let sentCount = 0;

      for (const username of activeSignerUsernames) {
        if (connectedSigners.includes(username)) {
          if (this.sendToSigner(username, request)) {
            sentCount++;
          }
        }
      }

      log.info(
        { txId: txRecord.id, sentTo: sentCount, threshold, batchSize: payments.length },
        "[Treasury] Batch signing request distributed",
      );

      if (sentCount < threshold) {
        log.warn({ sentCount, threshold }, "[Treasury] Not enough online signers for batch threshold");
        await storage.updateTreasuryTxStatus(txRecord.id, "failed");
        return { success: false };
      }

      return await new Promise<{ success: boolean; txId?: string }>((resolve) => {
        const timeout = setTimeout(async () => {
          this.pendingSigningSessions.delete(txRecord.id);
          await storage.updateTreasuryTxStatus(txRecord.id, "expired");
          log.warn({ txId: txRecord.id }, "[Treasury] Batch signing request expired");
          resolve({ success: false });
        }, SIGNING_TIMEOUT_MS);

        this.pendingSigningSessions.set(txRecord.id, { resolve, timeout });
      });
    } catch (err) {
      log.error({ err }, "[Treasury] Failed to submit batch transfer");
      return { success: false };
    }
  }

  // ============================================================
  // Signature Collection (called by agent-ws-manager)
  // ============================================================

  /**
   * Handle a signing response from a connected agent.
   * Now with: nonce replay check, signature verification, signer re-validation, audit logging.
   */
  async handleSigningResponse(
    username: string,
    txId: string,
    signature: string | null,
    rejected: boolean,
    rejectReason: string | null,
    nonce?: string,
  ): Promise<void> {
    // Audit: log all responses (accepted and rejected)
    this.auditLog(txId, username, rejected ? "rejected" : "signed", nonce, rejectReason ?? undefined);

    if (rejected || !signature) {
      log.info({ username, txId, rejectReason }, "[Treasury] Signer rejected");
      return;
    }

    const tx = await storage.getTreasuryTransaction(txId);
    if (!tx || tx.status === "broadcast" || tx.status === "expired" || tx.status === "failed") {
      return; // Already resolved
    }

    // SECURITY: Check expiration server-side (not just agent-side)
    if (tx.expiresAt && new Date(tx.expiresAt).getTime() < Date.now()) {
      log.warn({ txId, username }, "[Treasury] Signing response for expired tx");
      return;
    }

    // SECURITY: Nonce replay check
    if (nonce && this.usedNonces.has(nonce)) {
      const originalTxId = this.usedNonces.get(nonce);
      if (originalTxId !== txId) {
        log.error({ txId, username, nonce }, "[Treasury] NONCE REUSE DETECTED — possible replay");
        return;
      }
    }

    // SECURITY: Verify signer is still active at signature acceptance time
    const signer = await storage.getTreasurySignerByUsername(username);
    if (!signer || signer.status !== "active") {
      log.warn({ username, txId }, "[Treasury] Signature from non-active signer — rejected");
      return;
    }

    // SECURITY: Cryptographically verify the signature against the signer's public key
    const verifyResult = await this.verifySignature(username, tx.txDigest, signature);
    if (!verifyResult) {
      log.error({ username, txId }, "[Treasury] INVALID SIGNATURE — cryptographic verification failed");
      this.auditLog(txId, username, "invalid_signature", nonce);
      return;
    }

    // Store the verified signature
    await storage.updateTreasuryTxSignature(txId, username, signature);

    // Re-read to get updated signature count
    const updated = await storage.getTreasuryTransaction(txId);
    if (!updated) return;

    const sigs = updated.signatures as Record<string, string>;
    const sigCount = Object.keys(sigs).length;

    log.info(
      { txId, username, sigCount, threshold: updated.threshold },
      "[Treasury] Signature collected",
    );

    // Check if threshold met — with broadcast guard to prevent concurrent attempts
    if (sigCount >= updated.threshold && !this.broadcastingTxIds.has(txId)) {
      this.broadcastingTxIds.add(txId);
      try {
        // SECURITY: Re-validate ALL signers are still active at broadcast time
        const activeSigners = await storage.getActiveTreasurySigners();
        const activeUsernames = new Set(activeSigners.map(s => s.username));
        const validSigs: Record<string, string> = {};
        for (const [sigUser, sig] of Object.entries(sigs)) {
          if (activeUsernames.has(sigUser)) {
            validSigs[sigUser] = sig;
          } else {
            log.warn({ username: sigUser, txId }, "[Treasury] Signer no longer active at broadcast — discarding signature");
          }
        }
        if (Object.keys(validSigs).length < updated.threshold) {
          log.warn({ txId, validSigs: Object.keys(validSigs).length, threshold: updated.threshold },
            "[Treasury] Not enough valid signatures after re-validation");
          this.broadcastingTxIds.delete(txId);
          return; // Wait for more signatures
        }

        // Parse the ORIGINAL transaction exactly as it was built (same ref_block, expiration)
        const originalTx = JSON.parse(updated.operationsJson);

        // SECURITY: Verify digest matches before broadcast
        const recomputedDigest = (cryptoUtils as any).transactionDigest(
          originalTx, (this.client as any).chainId,
        );
        if (recomputedDigest.toString("hex") !== updated.txDigest) {
          log.error({ txId }, "[Treasury] DIGEST MISMATCH at broadcast — operationsJson tampered!");
          await storage.updateTreasuryTxStatus(txId, "failed");
          this.auditLog(txId, "system", "digest_mismatch_at_broadcast");
          return;
        }

        // Assemble with collected signatures and broadcast
        const signedTx = assembleSignedTransaction(
          originalTx,
          Object.values(validSigs),
        );
        const result = await broadcastMultisig(this.client, signedTx);

        await storage.updateTreasuryTxStatus(txId, "broadcast", result.id);
        log.info({ txId, hiveTxId: result.id }, "[Treasury] Multisig tx broadcast!");
        this.auditLog(txId, "system", "broadcast", undefined, undefined, result.id);

        // Resolve the pending session
        const session = this.pendingSigningSessions.get(txId);
        if (session) {
          clearTimeout(session.timeout);
          session.resolve({ success: true, txId: result.id });
          this.pendingSigningSessions.delete(txId);
        }
      } catch (err) {
        log.error({ err, txId }, "[Treasury] Broadcast failed");
        await storage.updateTreasuryTxStatus(txId, "failed");

        const session = this.pendingSigningSessions.get(txId);
        if (session) {
          clearTimeout(session.timeout);
          session.resolve({ success: false });
          this.pendingSigningSessions.delete(txId);
        }
      } finally {
        this.broadcastingTxIds.delete(txId);
      }
    }
  }

  // ============================================================
  // Authority Sync (Self-Healing)
  // ============================================================

  /**
   * Sync on-chain authority with database signer set.
   * Called on startup and every AUTHORITY_SYNC_INTERVAL_MS.
   */
  private async syncAuthority(): Promise<void> {
    try {
      const signers = await storage.getActiveTreasurySigners();

      // Check each signer is still a top-150 witness or has enough vouches
      for (const signer of signers) {
        const isWitness = await this.isTopWitness(signer.username);
        if (!isWitness) {
          const vouchCount = await storage.countActiveVouchesForCandidate(signer.username);
          if (vouchCount < MIN_TREASURY_VOUCHES) {
            log.warn(
              { username: signer.username },
              "[Treasury] Signer no longer qualified — removing",
            );
            await storage.updateSignerStatus(signer.username, "removed", {
              leftAt: new Date(),
            } as any);
          }
        }
      }

      // Also revoke vouches from deranked witnesses
      // (check all active treasury vouches — if the voucher is no longer top-150, revoke)
      // This is done lazily — we check vouchers of active signers
      for (const signer of signers) {
        const vouches = await storage.getActiveVouchesForCandidate(signer.username);
        for (const vouch of vouches) {
          const voucherStillWitness = await this.isTopWitness(vouch.voucherUsername);
          if (!voucherStillWitness) {
            await storage.revokeTreasuryVouch(
              vouch.voucherUsername,
              signer.username,
              "voucher_deranked",
            );
            log.info(
              { voucher: vouch.voucherUsername, candidate: signer.username },
              "[Treasury] Revoked vouch — voucher dropped from top-150",
            );
          }
        }
      }

      // Re-read signers after potential removals
      const activeSigners = await storage.getActiveTreasurySigners();
      if (activeSigners.length < MIN_SIGNERS_FOR_OPERATION) {
        this.authorityInSync = false;
        log.warn("[Treasury] Not enough signers for operation");
        return;
      }

      // Compare on-chain authority with expected
      const expectedSigners = activeSigners.map((s) => s.username);
      const expectedThreshold = computeThreshold(activeSigners.length);

      try {
        const onChainAuth = await readOnChainAuthority(this.client);
        this.authorityInSync = authorityMatchesSigners(
          onChainAuth,
          expectedSigners,
          expectedThreshold,
        );

        if (!this.authorityInSync) {
          log.info("[Treasury] Authority out of sync — initiating update");
          await this.initiateAuthorityUpdate();
        }
      } catch (err) {
        // Treasury account might not exist yet (pre-bootstrap)
        log.warn({ err }, "[Treasury] Could not read on-chain authority");
        this.authorityInSync = false;
      }
    } catch (err) {
      log.error({ err }, "[Treasury] Authority sync error");
    }
  }

  /**
   * Initiate an on-chain authority update to match the current signer set.
   */
  private async initiateAuthorityUpdate(): Promise<void> {
    const signers = await storage.getActiveTreasurySigners();
    if (signers.length < MIN_SIGNERS_FOR_OPERATION) return;

    const signerUsernames = signers.map((s) => s.username);
    const threshold = computeThreshold(signers.length);

    // Read current account info to preserve memo_key and json_metadata
    let memoKey: string | undefined;
    let jsonMetadata: string | undefined;
    try {
      const info = await readAccountInfo(this.client);
      memoKey = info.memoKey;
      jsonMetadata = info.jsonMetadata;
    } catch {
      // Account might not exist yet (pre-bootstrap)
    }
    const authorityOp = buildAuthorityUpdateOp(signerUsernames, threshold, memoKey, jsonMetadata);

    // If we have a genesis key and no current signers on-chain, use it directly
    if (this.genesisKey) {
      try {
        const onChainAuth = await readOnChainAuthority(this.client);
        const hasOnlyGenesisKey = onChainAuth.key_auths.length > 0
          && onChainAuth.account_auths.length === 0;

        if (hasOnlyGenesisKey) {
          log.info("[Treasury] Bootstrap: using genesis key for initial authority");
          const { PrivateKey } = await import("@hiveio/dhive");
          const { tx } = await buildUnsignedTransaction(this.client, [authorityOp]);
          const key = PrivateKey.fromString(this.genesisKey);
          const digest = (await import("@hiveio/dhive")).cryptoUtils.transactionDigest(
            tx,
            (this.client as any).chainId,
          );
          const sig = key.sign(digest).toString();
          const signedTx = assembleSignedTransaction(tx, [sig]);
          await broadcastMultisig(this.client, signedTx);
          log.info("[Treasury] Bootstrap authority set! Genesis key can be removed.");
          this.authorityInSync = true;
          return;
        }
      } catch (err) {
        log.error({ err }, "[Treasury] Genesis bootstrap failed");
      }
    }

    // Standard path: submit authority update through multisig signing
    try {
      const { tx, digest } = await buildUnsignedTransaction(this.client, [authorityOp]);
      const digestHex = digest.toString("hex");

      const txRecord = await storage.createTreasuryTransaction({
        txType: "authority_update",
        status: "signing",
        operationsJson: JSON.stringify(tx),
        txDigest: digestHex,
        signatures: {},
        threshold,
        expiresAt: new Date(Date.now() + SIGNING_TIMEOUT_MS),
        initiatedBy: "system",
        metadata: {
          newSigners: signerUsernames,
          newThreshold: threshold,
        },
      });

      // Send signing request to all currently-connected active signers
      const authNonce = randomUUID();
      this.trackNonce(authNonce, txRecord.id);

      const request: SigningRequest = {
        type: "SigningRequest",
        version: TREASURY_PROTOCOL_VERSION,
        txId: txRecord.id,
        nonce: authNonce,
        txDigest: digestHex,
        operations: tx.operations,
        tx,
        expiresAt: new Date(Date.now() + SIGNING_TIMEOUT_MS).toISOString(),
        metadata: { txType: "authority_update" },
      };

      const connectedSigners = this.getConnectedSigners();
      // For authority updates, we need signatures from the CURRENT on-chain authority,
      // not the new signer set — send to all connected signers
      for (const username of connectedSigners) {
        this.sendToSigner(username, request);
      }

      // Authority update is fire-and-forget from the coordinator's perspective
      // The handleSigningResponse flow will broadcast when threshold is met
    } catch (err) {
      log.error({ err }, "[Treasury] Failed to initiate authority update");
    }
  }

  // ============================================================
  // Security Helpers
  // ============================================================

  /** Track a nonce to prevent replay attacks. Evicts oldest when cache is full. */
  private trackNonce(nonce: string, txId: string): void {
    if (this.usedNonces.size >= TreasuryCoordinator.MAX_NONCE_CACHE) {
      // Evict oldest 20%
      const toDelete = Math.floor(TreasuryCoordinator.MAX_NONCE_CACHE * 0.2);
      const keys = this.usedNonces.keys();
      for (let i = 0; i < toDelete; i++) {
        const k = keys.next().value;
        if (k) this.usedNonces.delete(k);
      }
    }
    this.usedNonces.set(nonce, txId);
  }

  /**
   * Cryptographically verify a signature against the signer's Hive active public key.
   * Returns true if valid, false if invalid or verification fails.
   */
  private async verifySignature(username: string, txDigestHex: string, signatureHex: string): Promise<boolean> {
    try {
      const [account] = await this.client.database.getAccounts([username]);
      if (!account) return false;

      const digestBuffer = Buffer.from(txDigestHex, "hex");
      const sig = Signature.fromString(signatureHex);
      const recovered = sig.recover(digestBuffer);

      // Check against all active key authorities
      const activeAuth = (account as any).active;
      for (const [pubKeyStr] of activeAuth.key_auths) {
        const pubKey = PublicKey.fromString(pubKeyStr as string);
        if (recovered.toString() === pubKey.toString()) return true;
      }

      // Also check if username is in account_auths (account-level authority)
      // The signer uses their own active key, which is what we're checking
      return false;
    } catch (err: any) {
      log.error({ err: err.message, username }, "[Treasury] Signature verification failed");
      return false;
    }
  }

  /** Write an audit log entry for a treasury signing event. */
  private auditLog(
    txId: string,
    signerUsername: string,
    action: string,
    nonce?: string,
    rejectReason?: string,
    broadcastTxId?: string,
  ): void {
    // Fire-and-forget — audit logging should never block the signing flow
    storage.createTreasuryAuditLog?.({
      txId,
      signerUsername,
      action,
      nonce: nonce || null,
      rejectReason: rejectReason || null,
      txDigest: null,
      metadata: broadcastTxId ? { broadcastTxId } : null,
    }).catch((err: any) =>
      log.error({ err: err.message }, "[Treasury] Audit log write failed"),
    );
  }
}
