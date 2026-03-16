import { Client, PrivateKey, Asset, TransferOperation, CustomJsonOperation, Signature, PublicKey, cryptoUtils } from "@hiveio/dhive";
import crypto from "crypto";
import { logHive } from "../logger";

export interface HiveConfig {
  nodes: string[];
  username: string;
  postingKey?: string;
  activeKey?: string;
}

export interface HBDTransferRequest {
  to: string;
  amount: string;
  memo: string;
}

export interface CustomJsonRequest {
  id: string;
  json: object;
  requiredAuths?: string[];
  requiredPostingAuths?: string[];
}

export interface HiveTransaction {
  id: string;
  blockNumber: number;
  timestamp: Date;
}

/**
 * Transaction lifecycle statuses from transaction_status_api.find_transaction.
 * See: https://developers.hive.io/tutorials-recipes/understanding-transaction-status.html
 */
export type TxStatus =
  | "unknown"                  // Not seen by this node
  | "within_mempool"           // In mempool, not yet in a block
  | "within_reversible_block"  // In a block, but not yet irreversible
  | "within_irreversible_block" // Confirmed irreversible — safe
  | "expired_reversible"       // Expired from a reversible block (fork)
  | "expired_irreversible"     // Expired past irreversibility — tx is dead
  | "too_old";                 // Node has no record (too far back)

export interface TxStatusResult {
  status: TxStatus;
  blockNum?: number;
}

export class HiveClient {
  private client: Client;
  private config: HiveConfig;

  constructor(config: HiveConfig) {
    this.config = config;
    this.client = new Client(config.nodes);
  }

  async getAccount(username: string) {
    const accounts = await this.client.database.getAccounts([username]);
    return accounts[0] || null;
  }

  async getHBDBalance(username: string): Promise<string> {
    const account = await this.getAccount(username);
    if (!account) {
      throw new Error(`Account not found: ${username}`);
    }
    return account.hbd_balance.toString();
  }

  async getReputationScore(username: string): Promise<number> {
    const account = await this.getAccount(username);
    if (!account) {
      throw new Error(`Account not found: ${username}`);
    }
    const rep = parseFloat(account.reputation?.toString() || "0");
    if (rep === 0) return 25;
    const log = Math.log10(Math.abs(rep));
    const sign = rep >= 0 ? 1 : -1;
    const reputation = Math.max(((log - 9) * 9 * sign) + 25, 0);
    return Math.floor(reputation);
  }

  async transfer(request: HBDTransferRequest): Promise<HiveTransaction> {
    if (!this.config.activeKey) {
      throw new Error("Active key required for transfers");
    }

    const amount = Asset.fromString(request.amount);
    
    const op: TransferOperation = [
      "transfer",
      {
        from: this.config.username,
        to: request.to,
        amount: amount.toString(),
        memo: request.memo,
      },
    ];

    const key = PrivateKey.fromString(this.config.activeKey);
    const result = await this.client.broadcast.sendOperations([op], key);

    return {
      id: result.id,
      blockNumber: result.block_num,
      timestamp: new Date(),
    };
  }

  /**
   * Verify a Hive transfer transaction by looking up its transaction ID.
   * Returns transfer details if found, null if not found or not a transfer.
   */
  async verifyTransfer(txHash: string): Promise<{
    from: string;
    to: string;
    amount: string;
    memo: string;
  } | null> {
    try {
      // dhive doesn't have a direct tx lookup — use condenser API
      const result = await this.client.call("condenser_api", "get_transaction", [txHash]);
      if (!result || !result.operations || result.operations.length === 0) {
        return null;
      }
      // Find transfer operation in the transaction
      for (const [opType, opData] of result.operations) {
        if (opType === "transfer") {
          return {
            from: opData.from,
            to: opData.to,
            amount: opData.amount,
            memo: opData.memo || "",
          };
        }
      }
      return null;
    } catch (err) {
      logHive.error({ err, txHash }, "Failed to verify transfer");
      return null;
    }
  }

  async broadcastCustomJson(request: CustomJsonRequest): Promise<HiveTransaction> {
    if (!this.config.postingKey) {
      throw new Error("Posting key required for custom_json");
    }

    const op: CustomJsonOperation = [
      "custom_json",
      {
        id: request.id,
        json: JSON.stringify(request.json),
        required_auths: request.requiredAuths || [],
        required_posting_auths: request.requiredPostingAuths || [this.config.username],
      },
    ];

    const key = PrivateKey.fromString(this.config.postingKey);
    const result = await this.client.broadcast.sendOperations([op], key);

    return {
      id: result.id,
      blockNumber: result.block_num,
      timestamp: new Date(),
    };
  }

  async broadcastReputationUpdate(
    nodeUsername: string,
    oldReputation: number,
    newReputation: number,
    reason: string
  ): Promise<HiveTransaction> {
    return this.broadcastCustomJson({
      id: "spk_poa_reputation",
      json: {
        type: "reputation_update",
        node: nodeUsername,
        old_rep: oldReputation,
        new_rep: newReputation,
        reason,
        validator: this.config.username,
        timestamp: new Date().toISOString(),
      },
    });
  }

  async broadcastPoAResult(
    nodeUsername: string,
    cid: string,
    success: boolean,
    latencyMs: number,
    proofHash: string
  ): Promise<HiveTransaction> {
    return this.broadcastCustomJson({
      id: "spk_poa_result",
      json: {
        type: "poa_challenge_result",
        node: nodeUsername,
        cid,
        success,
        latency_ms: latencyMs,
        proof_hash: proofHash,
        validator: this.config.username,
        timestamp: new Date().toISOString(),
      },
    });
  }

  async getTopWitnesses(limit: number = 150): Promise<string[]> {
    const witnesses = await this.client.database.call("get_witnesses_by_vote", ["", limit]);
    return witnesses.map((w: any) => w.owner);
  }

  async isTopWitness(username: string, topN: number = 150): Promise<boolean> {
    const topWitnesses = await this.getTopWitnesses(topN);
    return topWitnesses.includes(username);
  }

  async getWitnessRank(username: string): Promise<number | null> {
    const witnesses = await this.getTopWitnesses(150);
    const index = witnesses.indexOf(username);
    return index >= 0 ? index + 1 : null;
  }

  async verifySignature(username: string, message: string, signature: string): Promise<boolean> {
    try {
      const account = await this.getAccount(username);
      if (!account) return false;

      const messageHash = cryptoUtils.sha256(message);
      const sig = Signature.fromString(signature);
      const recovered = sig.recover(messageHash);
      const recoveredStr = recovered.toString();

      const postingAuth = account.posting;
      for (const [pubKeyStr] of postingAuth.key_auths) {
        try {
          const pubKey = PublicKey.fromString(pubKeyStr as string);
          if (recoveredStr === pubKey.toString()) {
            return true;
          }
        } catch {
          continue;
        }
      }
      return false;
    } catch (error) {
      logHive.error({ err: error }, "Signature verification failed");
      return false;
    }
  }

  async getBlockchainTime(): Promise<Date> {
    const props = await this.client.database.getDynamicGlobalProperties();
    return new Date(props.time + "Z");
  }

  async getLatestBlockHash(): Promise<string> {
    const props = await this.client.database.getDynamicGlobalProperties();
    return props.head_block_id;
  }

  /**
   * Query the lifecycle status of a transaction by its ID.
   * Uses transaction_status_api.find_transaction (available on most public nodes).
   */
  async findTransaction(trxId: string): Promise<TxStatusResult> {
    try {
      const result = await this.client.call("transaction_status_api", "find_transaction", {
        transaction_id: trxId,
      });
      return {
        status: result.status as TxStatus,
        blockNum: result.block_num || undefined,
      };
    } catch (err) {
      logHive.warn({ err, trxId }, "find_transaction call failed — node may not support transaction_status_api");
      return { status: "unknown" };
    }
  }

  /**
   * Reconcile a broadcast whose response was ambiguous (timeout / network error).
   *
   * Polls transaction_status_api up to `maxAttempts` times (default 10, ~30s total)
   * and classifies the outcome as:
   *   - "confirmed"  → within_irreversible_block
   *   - "included"   → within_reversible_block (included but not yet irreversible)
   *   - "pending"    → within_mempool (still propagating)
   *   - "expired"    → expired_reversible | expired_irreversible (tx is dead, safe to resend)
   *   - "unknown"    → could not determine status after all attempts
   *
   * Callers should only resend when outcome is "expired" or "unknown" after exhausting retries.
   */
  async confirmTransaction(
    trxId: string,
    opts: { maxAttempts?: number; intervalMs?: number } = {},
  ): Promise<{ outcome: "confirmed" | "included" | "pending" | "expired" | "unknown"; blockNum?: number }> {
    const maxAttempts = opts.maxAttempts ?? 10;
    const intervalMs = opts.intervalMs ?? 3000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { status, blockNum } = await this.findTransaction(trxId);

      switch (status) {
        case "within_irreversible_block":
          logHive.info({ trxId, blockNum, attempt }, "Transaction confirmed irreversible");
          return { outcome: "confirmed", blockNum };

        case "within_reversible_block":
          logHive.info({ trxId, blockNum, attempt }, "Transaction included in reversible block");
          // Keep polling — we want irreversibility for certainty
          if (attempt === maxAttempts) return { outcome: "included", blockNum };
          break;

        case "within_mempool":
          logHive.debug({ trxId, attempt }, "Transaction in mempool, waiting...");
          if (attempt === maxAttempts) return { outcome: "pending" };
          break;

        case "expired_reversible":
        case "expired_irreversible":
          logHive.warn({ trxId, status, attempt }, "Transaction expired — safe to resend");
          return { outcome: "expired" };

        case "too_old":
          // Node has no record — fall back to condenser_api lookup
          try {
            const tx = await this.client.call("condenser_api", "get_transaction", [trxId]);
            if (tx && tx.block_num) {
              logHive.info({ trxId, blockNum: tx.block_num }, "Transaction found via condenser fallback");
              return { outcome: "confirmed", blockNum: tx.block_num };
            }
          } catch {
            // condenser fallback also failed
          }
          logHive.warn({ trxId, attempt }, "Transaction too old and not found via condenser");
          return { outcome: "unknown" };

        case "unknown":
        default:
          if (attempt === maxAttempts) {
            logHive.warn({ trxId }, "Transaction status unknown after all attempts");
            return { outcome: "unknown" };
          }
          break;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    return { outcome: "unknown" };
  }

  /**
   * Broadcast a transfer with structured logging and trx_id capture.
   * Wraps the base transfer() — callers that need reconciliation on ambiguous
   * outcomes should catch errors and call confirmTransaction(trxId).
   */
  async transferWithReconciliation(request: HBDTransferRequest): Promise<HiveTransaction> {
    logHive.info({ to: request.to, amount: request.amount, memo: request.memo }, "Broadcasting HBD transfer");
    try {
      const tx = await this.transfer(request);
      logHive.info({ trxId: tx.id, blockNum: tx.blockNumber, to: request.to, amount: request.amount }, "Transfer broadcast accepted");
      return tx;
    } catch (err: any) {
      // Ambiguous outcome — the tx may have landed even though we got an error
      logHive.error({ err, to: request.to, amount: request.amount }, "Transfer broadcast error — outcome ambiguous, manual reconciliation needed");
      throw err;
    }
  }

  /**
   * Broadcast a custom_json with structured logging and trx_id capture.
   */
  async broadcastCustomJsonWithReconciliation(request: CustomJsonRequest): Promise<HiveTransaction> {
    logHive.info({ customJsonId: request.id }, "Broadcasting custom_json");
    try {
      const tx = await this.broadcastCustomJson(request);
      logHive.info({ trxId: tx.id, blockNum: tx.blockNumber, customJsonId: request.id }, "custom_json broadcast accepted");
      return tx;
    } catch (err: any) {
      logHive.error({ err, customJsonId: request.id }, "custom_json broadcast error — outcome ambiguous");
      throw err;
    }
  }
}

export class MockHiveClient {
  private config: HiveConfig;
  private mockBalances: Map<string, string> = new Map();
  private transactionCounter = 0;

  constructor(config: HiveConfig) {
    this.config = config;
  }

  async getAccount(username: string) {
    return {
      name: username,
      hbd_balance: this.mockBalances.get(username) || "0.000 HBD",
      reputation: 10000000000000,
    };
  }

  async getHBDBalance(username: string): Promise<string> {
    return this.mockBalances.get(username) || "0.000 HBD";
  }

  async getReputationScore(username: string): Promise<number> {
    return 50 + Math.floor(Math.random() * 30);
  }

  async transfer(request: HBDTransferRequest): Promise<HiveTransaction> {
    logHive.info(`[Mock Hive] Transfer: ${request.amount} from ${this.config.username} to ${request.to}`);
    this.transactionCounter++;
    return {
      id: `mock_tx_${this.transactionCounter}`,
      blockNumber: Math.floor(Date.now() / 3000),
      timestamp: new Date(),
    };
  }

  async verifyTransfer(txHash: string): Promise<{
    from: string;
    to: string;
    amount: string;
    memo: string;
  } | null> {
    logHive.info(`[Mock Hive] Verify transfer: ${txHash}`);
    // In mock mode, accept any tx hash as valid
    return {
      from: "mock-depositor",
      to: this.config.username,
      amount: "10.000 HBD",
      memo: `hivepoa:contract:mock`,
    };
  }

  async broadcastCustomJson(request: CustomJsonRequest): Promise<HiveTransaction> {
    logHive.info({ customJsonId: request.id }, "Mock Custom JSON broadcast");
    this.transactionCounter++;
    return {
      id: `mock_tx_${this.transactionCounter}`,
      blockNumber: Math.floor(Date.now() / 3000),
      timestamp: new Date(),
    };
  }

  async broadcastReputationUpdate(
    nodeUsername: string,
    oldReputation: number,
    newReputation: number,
    reason: string
  ): Promise<HiveTransaction> {
    return this.broadcastCustomJson({
      id: "spk_poa_reputation",
      json: { nodeUsername, oldReputation, newReputation, reason },
    });
  }

  async broadcastPoAResult(
    nodeUsername: string,
    cid: string,
    success: boolean,
    latencyMs: number,
    proofHash: string
  ): Promise<HiveTransaction> {
    return this.broadcastCustomJson({
      id: "spk_poa_result",
      json: { nodeUsername, cid, success, latencyMs, proofHash },
    });
  }

  async getTopWitnesses(limit: number = 150): Promise<string[]> {
    return [
      "blocktrades", "gtg", "good-karma", "ausbitbank", "roelandp",
      "themarkymark", "steempress", "anyx", "pharesim", "someguy123",
      "dandandan123", // Test validator account
      "pro-content", // Test validator account
    ].slice(0, limit);
  }

  async isTopWitness(username: string, topN: number = 150): Promise<boolean> {
    const topWitnesses = await this.getTopWitnesses(topN);
    return topWitnesses.includes(username);
  }

  async getWitnessRank(username: string): Promise<number | null> {
    const witnesses = await this.getTopWitnesses(150);
    const index = witnesses.indexOf(username);
    return index >= 0 ? index + 1 : null;
  }

  async verifySignature(username: string, message: string, signature: string): Promise<boolean> {
    return signature.length > 10;
  }

  async getBlockchainTime(): Promise<Date> {
    return new Date();
  }

  async getLatestBlockHash(): Promise<string> {
    return crypto
      .createHash("sha256")
      .update(`mock-block-${Math.floor(Date.now() / 3000)}`)
      .digest("hex");
  }

  async findTransaction(trxId: string): Promise<TxStatusResult> {
    return { status: "within_irreversible_block", blockNum: Math.floor(Date.now() / 3000) };
  }

  async confirmTransaction(trxId: string): Promise<{ outcome: "confirmed" | "included" | "pending" | "expired" | "unknown"; blockNum?: number }> {
    return { outcome: "confirmed", blockNum: Math.floor(Date.now() / 3000) };
  }

  async transferWithReconciliation(request: HBDTransferRequest): Promise<HiveTransaction> {
    return this.transfer(request);
  }

  async broadcastCustomJsonWithReconciliation(request: CustomJsonRequest): Promise<HiveTransaction> {
    return this.broadcastCustomJson(request);
  }

  setBalance(username: string, balance: string): void {
    this.mockBalances.set(username, balance);
  }
}

const DEFAULT_HIVE_NODES = [
  "https://api.hive.blog",
  "https://api.openhive.network",
  "https://anyx.io",
  "https://hived.emre.sh",
];

export function createHiveClient(config?: Partial<HiveConfig>): HiveClient | MockHiveClient {
  const username = config?.username || process.env.HIVE_USERNAME || "anonymous";
  const postingKey = config?.postingKey || process.env.HIVE_POSTING_KEY;
  const activeKey = config?.activeKey || process.env.HIVE_ACTIVE_KEY;
  const nodes = config?.nodes || DEFAULT_HIVE_NODES;

  if (process.env.HIVE_POSTING_KEY || process.env.HIVE_ACTIVE_KEY) {
    return new HiveClient({ nodes, username, postingKey, activeKey });
  }

  logHive.info("[Hive] No keys configured, using mock client");
  return new MockHiveClient({ nodes, username });
}
