/**
 * Treasury Anomaly Detector — Monitors spending patterns for suspicious activity.
 *
 * Checks: burst frequency, amount spikes, rapid same-recipient payments.
 * Auto-freeze trigger: 3+ anomalies within 1 hour.
 */

import { logHive } from "../logger";

const log = logHive;

interface TransactionRecord {
  timestamp: number;
  recipient: string;
  amountHbd: number;
  txId: string;
}

// Detection windows
const BURST_WINDOW_MS = 10 * 60 * 1000;       // 10 minutes
const BURST_THRESHOLD = 5;                      // >5 txs in 10 min
const RAPID_SUCCESSION_MS = 5 * 60 * 1000;     // same recipient within 5 min
const ANOMALY_WINDOW_MS = 60 * 60 * 1000;      // 1 hour
const AUTO_FREEZE_ANOMALY_COUNT = 3;
const AMOUNT_SPIKE_MULTIPLIER = 3;              // >3x the rolling average
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class TreasuryAnomalyDetector {
  private recentTransactions: TransactionRecord[] = [];
  private anomalyTimestamps: number[] = [];

  /**
   * Record a transaction and return any anomaly flags detected.
   */
  recordTransaction(
    recipient: string,
    amountHbd: number,
    txId: string,
    isNewRecipient: boolean,
  ): string[] {
    const now = Date.now();
    const flags: string[] = [];

    // Prune old records
    this.recentTransactions = this.recentTransactions.filter(
      (t) => now - t.timestamp < HISTORY_RETENTION_MS,
    );
    this.anomalyTimestamps = this.anomalyTimestamps.filter(
      (ts) => now - ts < ANOMALY_WINDOW_MS,
    );

    // Check 1: Burst — too many transactions in short window
    const recentCount = this.recentTransactions.filter(
      (t) => now - t.timestamp < BURST_WINDOW_MS,
    ).length;
    if (recentCount >= BURST_THRESHOLD) {
      flags.push("burst");
    }

    // Check 2: New recipient (caller provides this from DB lookup)
    if (isNewRecipient) {
      flags.push("new_recipient");
    }

    // Check 3: Amount spike — significantly above rolling average
    if (this.recentTransactions.length >= 5) {
      const avg =
        this.recentTransactions.reduce((s, t) => s + t.amountHbd, 0) /
        this.recentTransactions.length;
      if (avg > 0 && amountHbd > avg * AMOUNT_SPIKE_MULTIPLIER) {
        flags.push("amount_spike");
      }
    }

    // Check 4: Rapid succession — same recipient paid twice within 5 min
    const lastToSame = this.recentTransactions
      .filter((t) => t.recipient === recipient)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (lastToSame && now - lastToSame.timestamp < RAPID_SUCCESSION_MS) {
      flags.push("rapid_succession");
    }

    // Record this transaction
    this.recentTransactions.push({ timestamp: now, recipient, amountHbd, txId });

    // Record anomalies
    if (flags.length > 0) {
      this.anomalyTimestamps.push(now);
      log.warn({ txId, recipient, amountHbd, flags }, "[Treasury] Anomaly detected");
    }

    return flags;
  }

  /**
   * Returns true if anomaly count in the last hour exceeds auto-freeze threshold.
   */
  shouldAutoFreeze(): boolean {
    const now = Date.now();
    const recentAnomalies = this.anomalyTimestamps.filter(
      (ts) => now - ts < ANOMALY_WINDOW_MS,
    );
    return recentAnomalies.length >= AUTO_FREEZE_ANOMALY_COUNT;
  }
}
