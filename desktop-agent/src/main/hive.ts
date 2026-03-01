import { Client, PrivateKey, CustomJsonOperation, Signature, PublicKey, cryptoUtils } from '@hiveio/dhive';

// 7 public Hive API nodes — dhive rotates through them automatically on failure
const DEFAULT_HIVE_NODES = [
  'https://api.hive.blog',
  'https://api.openhive.network',
  'https://anyx.io',
  'https://api.deathwing.me',
  'https://hive-api.arcange.eu',
  'https://techcoderx.com',
  'https://rpc.mahdiyari.info',
];

export interface AgentHiveConfig {
  nodes?: string[];
  username: string;
  postingKey?: string;
  /** On-demand key retrieval callback — preferred over storing key in memory permanently.
   *  When provided, the plaintext key is only decrypted briefly for each signing/broadcast operation
   *  and is eligible for GC immediately after, reducing the attack surface window. */
  getPostingKey?: () => string | null;
}

/**
 * Rate-limited Hive blockchain client.
 * Caches frequently-used responses, rotates API nodes on failure,
 * and checks Resource Credits before broadcasting.
 */
export class AgentHiveClient {
  private client: Client;
  private config: AgentHiveConfig;

  // Cache for getDynamicGlobalProperties (shared across callers)
  private cachedProps: { data: any; expiresAt: number } | null = null;
  private static readonly PROPS_CACHE_TTL = 3000; // 3 seconds

  // Rate limiter: track calls per second
  private callTimestamps: number[] = [];
  private static readonly MAX_CALLS_PER_SECOND = 3;
  private static readonly CALL_WINDOW_MS = 1000;

  // Backoff state
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private static readonly MAX_BACKOFF_MS = 60000; // 1 minute max

  // SECURITY: Random secret for HMAC fallback block hash (when Hive API is unavailable)
  private readonly fallbackSecret = require('crypto').randomBytes(32).toString('hex');

  constructor(config: AgentHiveConfig) {
    this.config = config;
    this.client = new Client(config.nodes || DEFAULT_HIVE_NODES, {
      timeout: 8000,         // 8s per-request timeout
      failoverThreshold: 2,  // switch node after 2 failures
      rebrandedApi: true,
    });
  }

  /**
   * SECURITY: Retrieve posting key on-demand.
   * Prefers the getPostingKey() callback (decrypts from OS keystore each time)
   * over the static postingKey field (held in memory permanently).
   * This minimizes the window where the plaintext key exists in memory.
   */
  private getKey(): string | null {
    if (this.config.getPostingKey) {
      return this.config.getPostingKey();
    }
    return this.config.postingKey || null;
  }

  /** Wait if we're in backoff, and rate-limit calls. */
  private async throttle(): Promise<void> {
    // Backoff check
    const now = Date.now();
    if (now < this.backoffUntil) {
      const wait = this.backoffUntil - now;
      await new Promise(r => setTimeout(r, wait));
    }

    // Rate limit: max N calls per second
    this.callTimestamps = this.callTimestamps.filter(
      t => t > Date.now() - AgentHiveClient.CALL_WINDOW_MS
    );
    if (this.callTimestamps.length >= AgentHiveClient.MAX_CALLS_PER_SECOND) {
      const oldest = this.callTimestamps[0];
      const delay = AgentHiveClient.CALL_WINDOW_MS - (Date.now() - oldest) + 50;
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
    this.callTimestamps.push(Date.now());
  }

  /** Record API success (reset backoff). */
  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
  }

  /** Record API failure (increase backoff). */
  private onFailure(): void {
    this.consecutiveFailures++;
    const backoff = Math.min(
      1000 * Math.pow(2, this.consecutiveFailures),
      AgentHiveClient.MAX_BACKOFF_MS
    );
    this.backoffUntil = Date.now() + backoff;
    console.log(`[Hive] API failure #${this.consecutiveFailures}, backing off ${backoff}ms`);
  }

  /** Get dynamic global properties (cached). */
  async getDynamicGlobalProperties(): Promise<any> {
    const now = Date.now();
    if (this.cachedProps && now < this.cachedProps.expiresAt) {
      return this.cachedProps.data;
    }

    await this.throttle();
    try {
      const props = await this.client.database.getDynamicGlobalProperties();
      this.cachedProps = { data: props, expiresAt: now + AgentHiveClient.PROPS_CACHE_TTL };
      this.onSuccess();
      return props;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Get the latest block hash for challenge salt entropy. */
  async getLatestBlockHash(): Promise<string> {
    try {
      const props = await this.getDynamicGlobalProperties();
      return props.head_block_id;
    } catch (err) {
      console.error('[Hive] Failed to get block hash:', err);
      // SECURITY: Use HMAC with local secret instead of predictable SHA256(timestamp)
      const nodeCrypto = require('crypto');
      const secret = this.getKey() || this.fallbackSecret;
      return nodeCrypto.createHmac('sha256', secret)
        .update(`fallback-${Date.now()}-${nodeCrypto.randomBytes(8).toString('hex')}`)
        .digest('hex');
    }
  }

  /** Get current head block number. */
  async getHeadBlockNumber(): Promise<number> {
    const props = await this.getDynamicGlobalProperties();
    return props.head_block_number;
  }

  /**
   * Fetch multiple blocks in a single batched call via block_api.get_block_range.
   * Falls back to sequential fetch if the batch API isn't available.
   */
  async getBlockRange(startBlock: number, count: number): Promise<any[]> {
    if (count <= 0) return [];
    // Cap to 50 per batch (Hive API limit for get_block_range)
    const batchSize = Math.min(count, 50);

    await this.throttle();
    try {
      // Use the block_api.get_block_range RPC (1 call for up to 50 blocks)
      const result = await this.client.call('block_api', 'get_block_range', {
        starting_block_num: startBlock,
        count: batchSize,
      });
      this.onSuccess();
      return (result.blocks || []).map((b: any) => b.block || b);
    } catch (err: any) {
      // Fallback: some nodes don't support get_block_range
      // Fetch in small parallel batches of 3 with delays
      console.log('[Hive] get_block_range unavailable, using sequential fallback');
      this.onFailure();
      return this.getBlocksSequential(startBlock, batchSize);
    }
  }

  /** Sequential block fetch with rate limiting (fallback). */
  private async getBlocksSequential(startBlock: number, count: number): Promise<any[]> {
    const blocks: any[] = [];
    const PARALLEL = 3; // Fetch 3 blocks at a time

    for (let i = 0; i < count; i += PARALLEL) {
      const batch = [];
      for (let j = 0; j < PARALLEL && (i + j) < count; j++) {
        batch.push(startBlock + i + j);
      }

      await this.throttle();
      try {
        const results = await Promise.all(
          batch.map(num => this.client.database.getBlock(num))
        );
        this.onSuccess();
        blocks.push(...results.filter(Boolean));
      } catch (err) {
        this.onFailure();
        // Skip this batch on failure, continue with next
      }

      // Small delay between batches to avoid hammering
      if (i + PARALLEL < count) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    return blocks;
  }

  /** Fetch a specific block by number. */
  async getBlock(blockNum: number): Promise<any> {
    await this.throttle();
    try {
      const block = await this.client.database.getBlock(blockNum);
      this.onSuccess();
      return block;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Verify a Hive account exists. */
  async getAccount(username: string): Promise<any | null> {
    await this.throttle();
    try {
      const accounts = await this.client.database.getAccounts([username]);
      this.onSuccess();
      return accounts[0] || null;
    } catch (err) {
      this.onFailure();
      throw err;
    }
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

  /**
   * Check if the account has enough Resource Credits for a custom_json broadcast.
   * Returns false if RC is critically low to prevent failed broadcasts.
   */
  async hasEnoughRC(): Promise<boolean> {
    try {
      await this.throttle();
      const result = await this.client.call('rc_api', 'find_rc_accounts', {
        accounts: [this.config.username],
      });
      this.onSuccess();

      const rcAccount = result.rc_accounts?.[0];
      if (!rcAccount) return true; // Can't check, assume OK

      const currentMana = BigInt(rcAccount.rc_manabar?.current_mana || '0');
      // custom_json costs ~1-5 billion RC; require at least 10 billion to be safe
      const minRC = BigInt(10_000_000_000);
      return currentMana >= minRC;
    } catch {
      // If RC check fails, allow broadcast anyway (don't block on API issues)
      return true;
    }
  }

  /** Broadcast a custom_json operation (requires posting key + sufficient RC). */
  async broadcastCustomJson(id: string, json: object): Promise<string | null> {
    const postingKey = this.getKey();
    if (!postingKey) {
      console.log('[Hive] No posting key configured, skipping broadcast');
      return null;
    }

    // Check Resource Credits before broadcasting
    const hasRC = await this.hasEnoughRC();
    if (!hasRC) {
      console.log('[Hive] Insufficient Resource Credits, skipping broadcast');
      return null;
    }

    await this.throttle();
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

      const key = PrivateKey.fromString(postingKey);
      const result = await this.client.broadcast.sendOperations([op], key);
      this.onSuccess();
      console.log(`[Hive] Broadcast ${id}: block ${result.block_num}`);
      return result.id;
    } catch (err: any) {
      this.onFailure();
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

  /** Verify a Hive Keychain signature against the account's posting key authorities. */
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
    } catch (err: any) {
      console.error('[Hive] Signature verification failed:', err.message);
      return false;
    }
  }

  /**
   * Sign a message with the posting key for PubSub message authentication.
   * Returns the signature string, or null if no posting key is configured.
   */
  signMessage(message: string): string | null {
    const postingKey = this.getKey();
    if (!postingKey) return null;
    try {
      const key = PrivateKey.fromString(postingKey);
      const hash = cryptoUtils.sha256(message);
      return key.sign(hash).toString();
    } catch (err: any) {
      console.error('[Hive] Failed to sign message:', err.message);
      return null;
    }
  }

  /** Check if the client has a posting key configured. */
  hasPostingKey(): boolean {
    return !!this.getKey();
  }

  /** Get the configured username. */
  getUsername(): string {
    return this.config.username;
  }
}
