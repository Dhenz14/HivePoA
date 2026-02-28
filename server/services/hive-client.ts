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

      const postingAuth = account.posting;
      for (const [pubKeyStr] of postingAuth.key_auths) {
        try {
          const pubKey = PublicKey.fromString(pubKeyStr as string);
          const recovered = sig.recover(messageHash);
          if (recovered.toString() === pubKey.toString()) {
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
