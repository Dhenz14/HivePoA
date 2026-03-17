/**
 * Phase 1 Step 2: Compute Wallet Service
 *
 * Immutable ledger-based accounting for the compute marketplace.
 *
 * Design invariants:
 * 1. Every wallet-affecting fact is a durable row before any side effect.
 * 2. Balance is always derived: SUM(amount_hbd) from ledger, never cached.
 * 3. Every ledger write is idempotent via unique idempotency_key.
 * 4. Budget reservation uses pg_advisory_xact_lock (namespace 2) to serialize
 *    concurrent balance-check-and-debit for the same user.
 */
import { storage } from "../storage";
import { logCompute } from "../logger";
import {
  emitDepositRecorded,
  emitBudgetReserved,
  emitBudgetReleased,
  emitInsufficientBalance,
  emitReconciliationCompleted,
} from "./compute-events";
import type { ComputeWallet, ComputeWalletLedgerEntry } from "@shared/schema";

/**
 * Hash a username to a stable int32 for pg_advisory_xact_lock.
 * Same algorithm as routes.ts withUploadQuotaLock (djb2 variant).
 */
export function hashUsername(username: string): number {
  return Array.from(username).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
}

export interface DepositParams {
  username: string;
  txHash: string;
  amountHbd: string;
  blockNum?: number;
  memo?: string;
}

export interface ReconcileTransfer {
  from: string;
  txHash: string;
  amount: string;
  blockNum?: number;
  memo?: string;
}

export interface ReconcileResult {
  processed: number;
  skipped: number;
  errors: string[];
}

export class ComputeWalletService {

  // ================================================================
  // Wallet lifecycle
  // ================================================================

  /**
   * Get or create a wallet for a Hive username. Idempotent.
   */
  async getOrCreateWallet(username: string): Promise<ComputeWallet> {
    const existing = await storage.getComputeWalletByUsername(username);
    if (existing) return existing;

    try {
      return await storage.createComputeWallet({ hiveUsername: username });
    } catch (err: any) {
      // Race: another request created it between our check and insert.
      // Unique constraint on hive_username means we can safely re-fetch.
      if (err.message?.includes("unique") || err.code === "23505") {
        const wallet = await storage.getComputeWalletByUsername(username);
        if (wallet) return wallet;
      }
      throw err;
    }
  }

  // ================================================================
  // Balance (always derived from ledger)
  // ================================================================

  /**
   * Get the derived balance for a username.
   * Returns "0" if no wallet exists.
   */
  async getBalance(username: string): Promise<string> {
    const wallet = await storage.getComputeWalletByUsername(username);
    if (!wallet) return "0";
    return storage.getComputeWalletBalance(wallet.id);
  }

  /**
   * Get paginated ledger entries for a username.
   */
  async getLedger(username: string, limit = 50, offset = 0): Promise<ComputeWalletLedgerEntry[]> {
    const wallet = await storage.getComputeWalletByUsername(username);
    if (!wallet) return [];
    return storage.getWalletLedgerEntries(wallet.id, limit, offset);
  }

  // ================================================================
  // Deposits (chain-observed facts)
  // ================================================================

  /**
   * Record a deposit from a chain-observed transfer. Idempotent by txHash.
   */
  async recordDeposit(params: DepositParams): Promise<ComputeWalletLedgerEntry> {
    const idemKey = `deposit:${params.txHash}`;

    // Fast idempotency check
    const existing = await storage.getWalletLedgerByIdempotencyKey(idemKey);
    if (existing) return existing;

    const wallet = await this.getOrCreateWallet(params.username);

    const entry = await storage.createWalletLedgerEntry({
      walletId: wallet.id,
      entryType: "deposit",
      amountHbd: params.amountHbd,
      referenceType: "hive_tx",
      referenceId: params.txHash,
      idempotencyKey: idemKey,
      chainTxId: params.txHash,
      chainBlockNum: params.blockNum ?? null,
      memo: params.memo ?? null,
    });

    emitDepositRecorded({
      username: params.username,
      txHash: params.txHash,
      amountHbd: params.amountHbd,
      blockNum: params.blockNum,
    });

    logCompute.info({
      username: params.username, txHash: params.txHash,
      amountHbd: params.amountHbd, blockNum: params.blockNum,
    }, "Deposit recorded");

    return entry;
  }

  // ================================================================
  // Budget reservation (advisory-locked)
  // ================================================================

  /**
   * Reserve budget for a compute job. Atomic via pg_advisory_xact_lock.
   * Fails with 402 if insufficient balance.
   * Idempotent by jobId.
   */
  async reserveBudget(
    username: string,
    jobId: string,
    amountHbd: string,
  ): Promise<ComputeWalletLedgerEntry> {
    const idemKey = `reserve:${jobId}`;

    // Fast idempotency check (no lock needed)
    const existing = await storage.getWalletLedgerByIdempotencyKey(idemKey);
    if (existing) return existing;

    // Import pool lazily — may be null on SQLite
    const { pool } = await import("../db");

    if (!pool) {
      // SQLite path: single-process, no advisory lock needed
      return this.reserveBudgetInner(username, jobId, amountHbd, idemKey);
    }

    // PostgreSQL path: advisory lock serializes concurrent reservations for same user
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const hash = hashUsername(username);
      // Namespace 2 = wallet budget (namespace 1 = upload quota)
      await client.query("SELECT pg_advisory_xact_lock(2, $1)", [hash]);

      const result = await this.reserveBudgetInner(username, jobId, amountHbd, idemKey);

      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async reserveBudgetInner(
    username: string,
    jobId: string,
    amountHbd: string,
    idemKey: string,
  ): Promise<ComputeWalletLedgerEntry> {
    // Re-check idempotency inside the lock (another request may have completed)
    const existing = await storage.getWalletLedgerByIdempotencyKey(idemKey);
    if (existing) return existing;

    const wallet = await this.getOrCreateWallet(username);
    const balance = parseFloat(await storage.getComputeWalletBalance(wallet.id));
    const amount = parseFloat(amountHbd);

    if (balance < amount) {
      emitInsufficientBalance({
        username, required: amountHbd,
        available: balance.toFixed(3), jobId,
      });
      throw Object.assign(
        new Error(`INSUFFICIENT_BALANCE: need ${amountHbd} HBD, have ${balance.toFixed(3)} HBD`),
        { statusCode: 402 },
      );
    }

    const entry = await storage.createWalletLedgerEntry({
      walletId: wallet.id,
      entryType: "reservation",
      amountHbd: `-${amountHbd}`, // negative = debit
      referenceType: "compute_job",
      referenceId: jobId,
      idempotencyKey: idemKey,
      chainTxId: null,
      chainBlockNum: null,
      memo: `Budget reservation for job ${jobId}`,
    });

    emitBudgetReserved({ jobId, username, amountHbd });
    logCompute.info({ username, jobId, amountHbd }, "Budget reserved");

    return entry;
  }

  // ================================================================
  // Budget release (cancellation, failure, expiry)
  // ================================================================

  /**
   * Release unused budget back to wallet. Idempotent by jobId + reason.
   */
  async releaseBudget(
    jobId: string,
    amountHbd: string,
    reason: string,
  ): Promise<ComputeWalletLedgerEntry> {
    const idemKey = `release:${jobId}:${reason}`;

    const existing = await storage.getWalletLedgerByIdempotencyKey(idemKey);
    if (existing) return existing;

    // Find the reservation entry to get the wallet ID
    const reserveKey = `reserve:${jobId}`;
    const reserveEntry = await storage.getWalletLedgerByIdempotencyKey(reserveKey);
    if (!reserveEntry) {
      throw Object.assign(
        new Error(`NO_RESERVATION: no reservation found for job ${jobId}`),
        { statusCode: 404 },
      );
    }

    const entry = await storage.createWalletLedgerEntry({
      walletId: reserveEntry.walletId,
      entryType: "release",
      amountHbd, // positive = credit
      referenceType: "compute_job",
      referenceId: jobId,
      idempotencyKey: idemKey,
      chainTxId: null,
      chainBlockNum: null,
      memo: `Budget release: ${reason}`,
    });

    emitBudgetReleased({ jobId, amountHbd, reason });
    logCompute.info({ jobId, amountHbd, reason }, "Budget released");

    return entry;
  }

  // ================================================================
  // Payout credit (node operator receives funds)
  // ================================================================

  /**
   * Record a payout credit to a node operator's wallet.
   * Idempotent by payoutId.
   */
  async recordPayout(
    payoutId: string,
    nodeUsername: string,
    amountHbd: string,
  ): Promise<ComputeWalletLedgerEntry> {
    const idemKey = `payout:${payoutId}`;

    const existing = await storage.getWalletLedgerByIdempotencyKey(idemKey);
    if (existing) return existing;

    const wallet = await this.getOrCreateWallet(nodeUsername);

    const entry = await storage.createWalletLedgerEntry({
      walletId: wallet.id,
      entryType: "payout",
      amountHbd, // positive = credit
      referenceType: "compute_payout",
      referenceId: payoutId,
      idempotencyKey: idemKey,
      chainTxId: null,
      chainBlockNum: null,
      memo: `Payout credit ${payoutId}`,
    });

    logCompute.info({ payoutId, nodeUsername, amountHbd }, "Payout credit recorded");

    return entry;
  }

  // ================================================================
  // Deposit reconciliation (bulk chain-observed transfers)
  // ================================================================

  /**
   * Bulk process chain-observed transfers as deposits.
   * Each transfer is processed idempotently via recordDeposit().
   */
  async reconcileFromTransfers(transfers: ReconcileTransfer[]): Promise<ReconcileResult> {
    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const t of transfers) {
      try {
        const idemKey = `deposit:${t.txHash}`;
        const existing = await storage.getWalletLedgerByIdempotencyKey(idemKey);
        if (existing) {
          skipped++;
          continue;
        }

        await this.recordDeposit({
          username: t.from,
          txHash: t.txHash,
          amountHbd: t.amount,
          blockNum: t.blockNum,
          memo: t.memo,
        });
        processed++;
      } catch (err: any) {
        errors.push(`${t.txHash}: ${err.message}`);
      }
    }

    emitReconciliationCompleted({ processed, skipped, errors: errors.length });

    logCompute.info({ processed, skipped, errors: errors.length }, "Deposit reconciliation completed");

    return { processed, skipped, errors };
  }
}

export const computeWalletService = new ComputeWalletService();
