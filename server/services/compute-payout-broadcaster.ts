/**
 * Phase 1 Step 3: Compute Payout Broadcaster
 *
 * Single adapter for all outbound HBD transfers from the compute marketplace.
 * Enforces the pre-broadcast identity protocol:
 *
 *   1. Durable attempt row created BEFORE chain interaction
 *   2. Ambiguous ack resolved by chain observation, never by rebroadcast
 *   3. Monotonic state: queued → broadcast → confirmed (never backwards)
 *   4. Externally reconcilable via deterministic memo on-chain
 *
 * No handler outside this module may call hiveClient.transfer() for compute payouts.
 */
import { storage } from "../storage";
import { logCompute } from "../logger";
import { createHiveClient } from "./hive-client";
import type { HiveClient, MockHiveClient } from "./hive-client";
import type { ComputePayout, ComputePayoutBroadcast } from "@shared/schema";
import {
  emitBroadcastAttemptCreated,
  emitBroadcastSent,
  emitBroadcastConfirmed,
  emitBroadcastAmbiguous,
  emitBroadcastFailed,
  emitPayoutConfirmed,
  emitPayoutFailed,
} from "./compute-events";

const BROADCAST_SWEEP_INTERVAL_MS = 30 * 1000;
const MAX_BROADCAST_ATTEMPTS = 3;
// Age thresholds for resolving orphaned attempts
const CREATED_AGE_THRESHOLD_MS = 5 * 60 * 1000;   // 5 minutes
const AMBIGUOUS_AGE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export class ComputePayoutBroadcaster {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private hiveClient: HiveClient | MockHiveClient;
  private processing = false;

  constructor(hiveClient?: HiveClient | MockHiveClient) {
    this.hiveClient = hiveClient ?? createHiveClient();
  }

  async start(): Promise<void> {
    this.sweepTimer = setInterval(() => this.processQueue(), BROADCAST_SWEEP_INTERVAL_MS);
    logCompute.info("PayoutBroadcaster started — sweep interval 30s");
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ================================================================
  // Main sweep loop
  // ================================================================

  async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      // Phase 1: Broadcast queued payouts
      const queued = await storage.getQueuedComputePayouts(10);
      for (const payout of queued) {
        try {
          await this.broadcastPayout(payout);
        } catch (err) {
          logCompute.error({ err, payoutId: payout.id }, "broadcastPayout failed");
        }
      }

      // Phase 2: Confirm in-flight broadcasts
      const inflight = await storage.getInflightBroadcastAttempts();
      for (const attempt of inflight) {
        try {
          await this.confirmBroadcast(attempt);
        } catch (err) {
          logCompute.error({ err, attemptId: attempt.id }, "confirmBroadcast failed");
        }
      }
    } catch (err) {
      logCompute.error({ err }, "Broadcast sweep failed");
    } finally {
      this.processing = false;
    }
  }

  // ================================================================
  // Broadcast: pre-send identity → transfer → capture txId
  // ================================================================

  async broadcastPayout(payout: ComputePayout): Promise<void> {
    // 1. Check for existing in-flight attempt
    const latest = await storage.getLatestBroadcastAttempt(payout.id);
    if (latest) {
      if (latest.status === "sent" || latest.status === "ambiguous" || latest.status === "created") {
        // An attempt is still in-flight; confirmBroadcast will handle it
        return;
      }
      if (latest.status === "confirmed") {
        // Already confirmed — fix payout status if stale
        await storage.updateComputePayoutStatus(payout.id, "confirmed", latest.hiveTxId ?? undefined);
        return;
      }
    }

    // 2. Count failed attempts
    const allAttempts = await storage.getPayoutBroadcastAttemptsByPayout(payout.id);
    const failedCount = allAttempts.filter(a =>
      a.status === "failed_expired" || a.status === "failed_error",
    ).length;

    if (failedCount >= MAX_BROADCAST_ATTEMPTS) {
      await storage.updateComputePayoutStatus(payout.id, "failed");
      emitPayoutFailed({ payoutId: payout.id, totalAttempts: failedCount });
      logCompute.warn({ payoutId: payout.id, failedCount }, "Payout exhausted all broadcast attempts");
      return;
    }

    // 3. Resolve recipient
    const node = await storage.getComputeNode(payout.nodeId);
    if (!node) {
      logCompute.error({ payoutId: payout.id, nodeId: payout.nodeId }, "Cannot broadcast: node not found");
      return;
    }

    const attemptNumber = failedCount + 1;
    const idempotencyKey = `broadcast:${payout.id}:${attemptNumber}`;
    const memo = `hivepoa:compute:${payout.id}:${attemptNumber}`;

    // 4. CREATE DURABLE PRE-BROADCAST IDENTITY (the safety surface)
    let attempt: ComputePayoutBroadcast;
    try {
      attempt = await storage.createPayoutBroadcastAttempt({
        payoutId: payout.id,
        attemptNumber,
        idempotencyKey,
        recipientUsername: node.hiveUsername,
        amountHbd: payout.amountHbd,
        memo,
        status: "created",
        hiveTxId: null,
        chainBlockNum: null,
        errorMessage: null,
        resolvedAt: null,
      });
    } catch (err: any) {
      // Unique constraint → attempt already exists (crash recovery / race)
      if (err.message?.includes("unique") || err.code === "23505") {
        logCompute.warn({ payoutId: payout.id, attemptNumber }, "Broadcast attempt already exists");
        return;
      }
      throw err;
    }

    emitBroadcastAttemptCreated({
      payoutId: payout.id,
      attemptId: attempt.id,
      attemptNumber,
      recipientUsername: node.hiveUsername,
      amountHbd: payout.amountHbd,
      memo,
    });

    // 5. Attempt chain interaction
    try {
      const tx = await this.hiveClient.transfer({
        to: node.hiveUsername,
        amount: `${payout.amountHbd} HBD`,
        memo,
      });

      // Success — record txId
      await storage.updatePayoutBroadcastAttempt(attempt.id, {
        hiveTxId: tx.id,
        status: "sent",
        chainBlockNum: tx.blockNumber,
      });
      await storage.updateComputePayoutStatus(payout.id, "broadcast");

      emitBroadcastSent({
        payoutId: payout.id,
        attemptId: attempt.id,
        hiveTxId: tx.id,
      });

      logCompute.info({
        payoutId: payout.id, attemptId: attempt.id,
        hiveTxId: tx.id, recipient: node.hiveUsername, amountHbd: payout.amountHbd,
      }, "Payout broadcast sent");

    } catch (err: any) {
      // AMBIGUOUS ACK — tx may have landed despite the error
      await storage.updatePayoutBroadcastAttempt(attempt.id, {
        status: "ambiguous",
        errorMessage: (err.message || "Unknown error").slice(0, 500),
      });

      emitBroadcastAmbiguous({
        payoutId: payout.id,
        attemptId: attempt.id,
        errorMessage: err.message || "Unknown error",
      });

      logCompute.warn({
        payoutId: payout.id, attemptId: attempt.id, err,
      }, "Payout broadcast ambiguous — will resolve on next cycle");
    }
  }

  // ================================================================
  // Confirm: chain observation to resolve in-flight attempts
  // ================================================================

  async confirmBroadcast(attempt: ComputePayoutBroadcast): Promise<void> {
    const age = Date.now() - new Date(attempt.createdAt).getTime();

    // Handle "created" status — pre-send row without a completed transfer
    if (attempt.status === "created") {
      if (age < CREATED_AGE_THRESHOLD_MS) return; // too young, may still be in-flight
      // Crash recovery: transfer was never sent
      await storage.updatePayoutBroadcastAttempt(attempt.id, {
        status: "failed_error",
        errorMessage: "Pre-send row without broadcast (crash recovery)",
        resolvedAt: new Date(),
      });
      emitBroadcastFailed({
        payoutId: attempt.payoutId,
        attemptId: attempt.id,
        reason: "error",
        errorMessage: "Pre-send crash recovery",
      });
      return;
    }

    // Handle "sent" or "ambiguous" with a txId — poll the chain
    if (attempt.hiveTxId) {
      const result = await this.hiveClient.confirmTransaction(attempt.hiveTxId);

      switch (result.outcome) {
        case "confirmed":
          await this.markConfirmed(attempt, result.blockNum ?? attempt.chainBlockNum ?? 0);
          return;

        case "included":
        case "pending":
          // Still in flight — wait for next cycle
          return;

        case "expired":
          await storage.updatePayoutBroadcastAttempt(attempt.id, {
            status: "failed_expired",
            resolvedAt: new Date(),
          });
          emitBroadcastFailed({
            payoutId: attempt.payoutId,
            attemptId: attempt.id,
            reason: "expired",
          });
          logCompute.info({ attemptId: attempt.id, payoutId: attempt.payoutId }, "Broadcast expired — eligible for retry");
          return;

        case "unknown":
          // Try verifyTransfer fallback
          try {
            const transfer = await this.hiveClient.verifyTransfer(attempt.hiveTxId);
            if (transfer && transfer.memo === attempt.memo) {
              await this.markConfirmed(attempt, 0);
              return;
            }
          } catch {
            // verifyTransfer failed — continue waiting
          }
          // Still unknown — wait for next cycle
          return;
      }
    }

    // "ambiguous" with no txId — transfer() threw before returning a response
    if (attempt.status === "ambiguous" && !attempt.hiveTxId) {
      if (age < AMBIGUOUS_AGE_THRESHOLD_MS) return; // too young
      // Aged out — mark failed to allow retry
      await storage.updatePayoutBroadcastAttempt(attempt.id, {
        status: "failed_error",
        errorMessage: "Ambiguous broadcast with no txId — aged out",
        resolvedAt: new Date(),
      });
      emitBroadcastFailed({
        payoutId: attempt.payoutId,
        attemptId: attempt.id,
        reason: "error",
        errorMessage: "Ambiguous with no txId after age threshold",
      });
    }
  }

  // ================================================================
  // Terminal state: confirmed
  // ================================================================

  private async markConfirmed(attempt: ComputePayoutBroadcast, blockNum: number): Promise<void> {
    await storage.updatePayoutBroadcastAttempt(attempt.id, {
      status: "confirmed",
      chainBlockNum: blockNum,
      resolvedAt: new Date(),
    });
    await storage.updateComputePayoutStatus(
      attempt.payoutId, "confirmed", attempt.hiveTxId ?? undefined,
    );

    emitBroadcastConfirmed({
      payoutId: attempt.payoutId,
      attemptId: attempt.id,
      hiveTxId: attempt.hiveTxId || "",
      chainBlockNum: blockNum,
    });
    emitPayoutConfirmed({
      payoutId: attempt.payoutId,
      hiveTxId: attempt.hiveTxId || "",
      chainBlockNum: blockNum,
      recipientUsername: attempt.recipientUsername,
      amountHbd: attempt.amountHbd,
    });

    logCompute.info({
      payoutId: attempt.payoutId, attemptId: attempt.id,
      hiveTxId: attempt.hiveTxId, blockNum,
    }, "Payout confirmed on chain");
  }
}

export const computePayoutBroadcaster = new ComputePayoutBroadcaster();
