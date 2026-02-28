import { Client, PrivateKey, CustomJsonOperation } from '@hiveio/dhive';

const DEFAULT_HIVE_NODES = [
  'https://api.hive.blog',
  'https://api.openhive.network',
  'https://anyx.io',
];

export interface AgentHiveConfig {
  nodes?: string[];
  username: string;
  postingKey?: string;
}

export class AgentHiveClient {
  private client: Client;
  private config: AgentHiveConfig;

  constructor(config: AgentHiveConfig) {
    this.config = config;
    this.client = new Client(config.nodes || DEFAULT_HIVE_NODES);
  }

  /** Get the latest block hash for challenge salt entropy. */
  async getLatestBlockHash(): Promise<string> {
    try {
      const props = await this.client.database.getDynamicGlobalProperties();
      return props.head_block_id;
    } catch (err) {
      console.error('[Hive] Failed to get block hash:', err);
      // Fallback to timestamp-based hash for entropy
      const crypto = await import('crypto');
      return crypto.createHash('sha256')
        .update(`fallback-${Date.now()}`)
        .digest('hex');
    }
  }

  /** Get current head block number. */
  async getHeadBlockNumber(): Promise<number> {
    const props = await this.client.database.getDynamicGlobalProperties();
    return props.head_block_number;
  }

  /** Fetch a specific block by number. */
  async getBlock(blockNum: number): Promise<any> {
    return await this.client.database.getBlock(blockNum);
  }

  /** Verify a Hive account exists. */
  async getAccount(username: string): Promise<any | null> {
    const accounts = await this.client.database.getAccounts([username]);
    return accounts[0] || null;
  }

  /** Get Hive account reputation score (0-100 scale). */
  async getReputationScore(username: string): Promise<number> {
    const account = await this.getAccount(username);
    if (!account) return 0;

    const rep = parseFloat(account.reputation?.toString() || '0');
    if (rep === 0) return 25;
    const log = Math.log10(Math.abs(rep));
    const sign = rep >= 0 ? 1 : -1;
    const reputation = Math.max(((log - 9) * 9 * sign) + 25, 0);
    return Math.floor(reputation);
  }

  /** Broadcast a custom_json operation (requires posting key). */
  async broadcastCustomJson(id: string, json: object): Promise<string | null> {
    if (!this.config.postingKey) {
      console.log('[Hive] No posting key configured, skipping broadcast');
      return null;
    }

    try {
      const op: CustomJsonOperation = [
        'custom_json',
        {
          id,
          json: JSON.stringify(json),
          required_auths: [],
          required_posting_auths: [this.config.username],
        },
      ];

      const key = PrivateKey.fromString(this.config.postingKey);
      const result = await this.client.broadcast.sendOperations([op], key);
      console.log(`[Hive] Broadcast ${id}: block ${result.block_num}`);
      return result.id;
    } catch (err: any) {
      console.error(`[Hive] Failed to broadcast ${id}:`, err.message);
      return null;
    }
  }

  /** Announce this node on the Hive blockchain. */
  async broadcastNodeAnnounce(
    peerId: string,
    version: string,
    storageGB: number,
    pinCount: number
  ): Promise<string | null> {
    return this.broadcastCustomJson('hivepoa_node_announce', {
      type: 'announce',
      peerId,
      version,
      storageGB,
      pinCount,
      timestamp: new Date().toISOString(),
    });
  }

  /** Broadcast a PoA challenge result. */
  async broadcastPoAResult(
    node: string,
    cid: string,
    success: boolean,
    proofHash: string,
    latencyMs: number
  ): Promise<string | null> {
    return this.broadcastCustomJson('hivepoa_poa_result', {
      type: 'result',
      node,
      validator: this.config.username,
      cid,
      success,
      proofHash,
      latencyMs,
      timestamp: new Date().toISOString(),
    });
  }

  /** Check if the client has a posting key configured. */
  hasPostingKey(): boolean {
    return !!this.config.postingKey;
  }

  /** Get the configured username. */
  getUsername(): string {
    return this.config.username;
  }
}
