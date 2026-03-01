import { AgentHiveClient } from './hive';
import { ConfigStore } from './config';
import axios from 'axios';

export interface PeerInfo {
  hiveUsername: string;
  peerId: string;
  version: string;
  storageGB: number;
  pinCount: number;
  lastAnnounce: number;   // Unix timestamp ms
  reputation: number;     // Hive account reputation (0-100)
  lastChallengedAt: number; // Unix timestamp ms (local tracking)
  challengeResults: { success: number; fail: number };
}

/**
 * Discovers and maintains a roster of active P2P nodes
 * by scanning Hive blockchain for hivepoa_node_announce custom_json operations.
 *
 * Optimized to minimize Hive API calls:
 * - Uses batch block fetching (get_block_range — 1 call per 50 blocks)
 * - Scans only ~20 new blocks per poll (matching Hive's 3s block time × 60s poll)
 * - Adds jitter to scan interval to prevent thundering herd
 * - Backs off automatically on API errors (via AgentHiveClient)
 */
export class PeerDiscovery {
  private hive: AgentHiveClient;
  private config: ConfigStore;
  private peers: Map<string, PeerInfo> = new Map(); // keyed by hiveUsername
  private lastScannedBlock: number = 0;
  private scanInterval: NodeJS.Timeout | null = null;
  private announceInterval: NodeJS.Timeout | null = null;
  private kuboApiUrl: string = '';
  private myPeerId: string = '';
  private connectQueue: string[] = [];
  private activeConnects: number = 0;
  private static readonly MAX_CONCURRENT_CONNECTS = 3;

  // Sybil resistance: cache account verification results
  private verifiedAccounts: Map<string, { verified: boolean; checkedAt: number }> = new Map();
  private static readonly ACCOUNT_CACHE_TTL_MS = 3600000; // 1 hour
  private static readonly MIN_ACCOUNT_AGE_DAYS = 7;

  // Hive produces 1 block every 3 seconds → 20 blocks per minute
  // We scan every 60-90s (with jitter), so ~20-30 new blocks per scan
  private static readonly MAX_BLOCKS_PER_SCAN = 30;
  private static readonly SCAN_BASE_INTERVAL_MS = 60000;   // 60 seconds
  private static readonly SCAN_JITTER_MS = 30000;          // ±30 seconds
  private static readonly ANNOUNCE_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
  private static readonly STALE_CUTOFF_MS = 4 * 60 * 60 * 1000; // 4 hours

  constructor(hive: AgentHiveClient, config: ConfigStore) {
    this.hive = hive;
    this.config = config;

    // Restore last scanned block from config
    const stored = (this.config as any).store?.get('lastScannedBlock', 0) as number;
    if (stored) this.lastScannedBlock = stored;
  }

  setKuboInfo(kuboApiUrl: string, peerId: string): void {
    this.kuboApiUrl = kuboApiUrl;
    this.myPeerId = peerId;
  }

  /** Start periodic block scanning and self-announcement. */
  async start(): Promise<void> {
    console.log('[PeerDiscovery] Starting...');

    // Initial scan
    await this.scanBlocks();

    // Scan with jitter to prevent all agents scanning at exactly the same time
    this.scheduleScan();

    // Announce self immediately, then every 60 minutes
    await this.announceNode();
    this.announceInterval = setInterval(
      () => this.announceNode(),
      PeerDiscovery.ANNOUNCE_INTERVAL_MS
    );

    console.log(`[PeerDiscovery] Active with ${this.peers.size} known peers`);
  }

  /** Schedule next scan with random jitter. */
  private scheduleScan(): void {
    const jitter = Math.floor(Math.random() * PeerDiscovery.SCAN_JITTER_MS);
    const interval = PeerDiscovery.SCAN_BASE_INTERVAL_MS + jitter;

    this.scanInterval = setTimeout(() => {
      this.scanBlocks().then(() => this.scheduleScan());
    }, interval);
  }

  /** Stop scanning and announcing. */
  stop(): void {
    if (this.scanInterval) {
      clearTimeout(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    console.log('[PeerDiscovery] Stopped');
  }

  /**
   * Scan recent Hive blocks for hivepoa_node_announce operations.
   *
   * API cost: 1 call for getDynamicGlobalProperties (cached) +
   *           1 call for get_block_range (up to 30 blocks)
   *         = ~2 Hive API calls per scan
   */
  private async scanBlocks(): Promise<void> {
    try {
      const headBlock = await this.hive.getHeadBlockNumber();

      // On first run, start from ~5 minutes ago (100 blocks)
      // instead of 1 hour — reduces initial API load significantly
      if (this.lastScannedBlock === 0) {
        this.lastScannedBlock = Math.max(0, headBlock - 100);
      }

      // Only scan new blocks since last poll, capped to MAX_BLOCKS_PER_SCAN
      const startBlock = this.lastScannedBlock + 1;
      const blocksAvailable = headBlock - startBlock + 1;

      if (blocksAvailable <= 0) return;

      const blocksToFetch = Math.min(blocksAvailable, PeerDiscovery.MAX_BLOCKS_PER_SCAN);
      const fetchStart = headBlock - blocksToFetch + 1; // Scan most recent blocks

      // Batch fetch — 1 API call for up to 30 blocks
      const blocks = await this.hive.getBlockRange(fetchStart, blocksToFetch);

      let announceCount = 0;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block || !block.transactions) continue;

        for (const tx of block.transactions) {
          for (const op of tx.operations) {
            if (op[0] === 'custom_json' && op[1].id === 'hivepoa_node_announce') {
              try {
                const json = JSON.parse(op[1].json);
                const author = op[1].required_posting_auths?.[0] || '';
                if (author && json.type === 'announce') {
                  this.processAnnouncement(author, json);
                  announceCount++;
                }
              } catch {}
            }
          }
        }
      }

      this.lastScannedBlock = headBlock;
      (this.config as any).store?.set('lastScannedBlock', headBlock);

      if (announceCount > 0) {
        console.log(`[PeerDiscovery] Found ${announceCount} announcements in ${blocks.length} blocks`);
      }

      // Prune stale peers
      this.pruneStale();

    } catch (err: any) {
      console.error('[PeerDiscovery] Block scan error:', err.message);
      // Don't update lastScannedBlock on error — retry next cycle
    }
  }

  /** Process a peer announcement from the blockchain. */
  private processAnnouncement(hiveUsername: string, json: any): void {
    const cfg = this.config.getConfig();

    // Skip self
    if (hiveUsername === cfg.hiveUsername) return;

    const existing = this.peers.get(hiveUsername);

    const peer: PeerInfo = {
      hiveUsername,
      peerId: json.peerId || '',
      version: json.version || 'unknown',
      storageGB: json.storageGB || 0,
      pinCount: json.pinCount || 0,
      lastAnnounce: json.timestamp ? new Date(json.timestamp).getTime() : Date.now(),
      reputation: existing?.reputation || 25, // Will be updated lazily
      lastChallengedAt: existing?.lastChallengedAt || 0,
      challengeResults: existing?.challengeResults || { success: 0, fail: 0 },
    };

    this.peers.set(hiveUsername, peer);

    if (!existing) {
      console.log(`[PeerDiscovery] New peer: ${hiveUsername} (${peer.peerId.slice(0, 12)}...)`);

      // Sybil resistance: verify account age and reputation for new peers
      this.verifyAccount(hiveUsername).catch(() => {});

      // Try to connect to the new peer via IPFS swarm
      this.connectToPeer(peer.peerId);
    }
  }

  /**
   * Sybil resistance: verify a Hive account meets minimum requirements.
   * - Account must be at least 7 days old (prevents mass account creation)
   * - Account reputation must meet minimum threshold
   * Results are cached for 1 hour. On API failure, peer is kept (fail-open).
   */
  private async verifyAccount(username: string): Promise<void> {
    const cached = this.verifiedAccounts.get(username);
    if (cached && Date.now() - cached.checkedAt < PeerDiscovery.ACCOUNT_CACHE_TTL_MS) {
      if (!cached.verified) {
        this.peers.delete(username);
        console.log(`[PeerDiscovery] Rejected peer ${username} (cached: failed verification)`);
      }
      return;
    }

    try {
      const account = await this.hive.getAccount(username);
      if (!account) {
        this.verifiedAccounts.set(username, { verified: false, checkedAt: Date.now() });
        this.peers.delete(username);
        console.log(`[PeerDiscovery] Rejected peer ${username} — account not found`);
        return;
      }

      // Check account age (created field is ISO timestamp)
      const createdDate = new Date(account.created);
      const ageDays = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < PeerDiscovery.MIN_ACCOUNT_AGE_DAYS) {
        this.verifiedAccounts.set(username, { verified: false, checkedAt: Date.now() });
        this.peers.delete(username);
        console.log(`[PeerDiscovery] Rejected peer ${username} — account too new (${Math.floor(ageDays)} days, need ${PeerDiscovery.MIN_ACCOUNT_AGE_DAYS})`);
        return;
      }

      // Check reputation
      const cfg = this.config.getConfig();
      const reputation = await this.hive.getReputationScore(username);
      if (reputation < cfg.minPeerReputation) {
        this.verifiedAccounts.set(username, { verified: false, checkedAt: Date.now() });
        this.peers.delete(username);
        console.log(`[PeerDiscovery] Rejected peer ${username} — reputation ${reputation} below minimum ${cfg.minPeerReputation}`);
        return;
      }

      // Update peer's stored reputation
      const peer = this.peers.get(username);
      if (peer) {
        peer.reputation = reputation;
      }

      this.verifiedAccounts.set(username, { verified: true, checkedAt: Date.now() });
    } catch (err: any) {
      // Fail-open: keep the peer on API failure (don't block due to temporary Hive API issues)
      console.log(`[PeerDiscovery] Account verification deferred for ${username}: ${err.message}`);
    }
  }

  /** Queue a swarm connect to avoid CPU/network spikes from concurrent connections. */
  private connectToPeer(peerId: string): void {
    if (!this.kuboApiUrl || !peerId) return;
    this.connectQueue.push(peerId);
    this.drainConnectQueue();
  }

  private async drainConnectQueue(): Promise<void> {
    while (this.connectQueue.length > 0 && this.activeConnects < PeerDiscovery.MAX_CONCURRENT_CONNECTS) {
      const peerId = this.connectQueue.shift()!;
      this.activeConnects++;
      axios.post(
        `${this.kuboApiUrl}/api/v0/swarm/connect?arg=/p2p/${peerId}`,
        null,
        { timeout: 10000 }
      ).then(() => {
        console.log(`[PeerDiscovery] Connected to peer ${peerId.slice(0, 12)}...`);
      }).catch(() => {
        // Connection failures are normal — peer may not be directly reachable
      }).finally(() => {
        this.activeConnects--;
        this.drainConnectQueue();
      });
    }
  }

  /** Announce this node on the Hive blockchain. */
  private async announceNode(): Promise<void> {
    const cfg = this.config.getConfig();
    if (!cfg.hiveUsername) return;

    // Get pin count from IPFS
    let pinCount = 0;
    if (this.kuboApiUrl) {
      try {
        const response = await axios.post(
          `${this.kuboApiUrl}/api/v0/pin/ls?type=recursive`,
          null,
          { timeout: 5000 }
        );
        pinCount = Object.keys(response.data.Keys || {}).length;
      } catch {}
    }

    const { app } = require('electron');
    const txId = await this.hive.broadcastNodeAnnounce(
      this.myPeerId,
      app.getVersion(),
      cfg.storageMaxGB,
      pinCount
    );

    if (txId) {
      console.log(`[PeerDiscovery] Announced node on Hive (tx: ${txId.slice(0, 12)}...)`);
    }
  }

  /** Remove peers not seen in 4 hours. */
  private pruneStale(): void {
    const cutoff = Date.now() - PeerDiscovery.STALE_CUTOFF_MS;
    for (const [username, peer] of this.peers) {
      if (peer.lastAnnounce < cutoff) {
        this.peers.delete(username);
        console.log(`[PeerDiscovery] Pruned stale peer: ${username}`);
      }
    }
  }

  /** Get peers eligible for challenging (exclude self, stale, recently challenged). */
  getEligiblePeers(): PeerInfo[] {
    const cfg = this.config.getConfig();
    const now = Date.now();
    const challengeCooldown = Math.max(60000, cfg.challengeIntervalMs / 2); // Min 1 minute cooldown

    return Array.from(this.peers.values()).filter(peer => {
      // Skip self
      if (peer.hiveUsername === cfg.hiveUsername) return false;
      // Skip stale (>4h)
      if (now - peer.lastAnnounce > PeerDiscovery.STALE_CUTOFF_MS) return false;
      // Skip recently challenged
      if (now - peer.lastChallengedAt < challengeCooldown) return false;
      // Skip low reputation
      if (peer.reputation < cfg.minPeerReputation) return false;
      return true;
    });
  }

  /** Select a random peer for challenging. */
  selectRandomPeer(): PeerInfo | null {
    const eligible = this.getEligiblePeers();
    if (eligible.length === 0) return null;
    return eligible[Math.floor(Math.random() * eligible.length)];
  }

  /** Record that a peer was challenged (for cooldown tracking). */
  recordChallenge(username: string, success: boolean): void {
    const peer = this.peers.get(username);
    if (!peer) return;

    peer.lastChallengedAt = Date.now();
    if (success) {
      peer.challengeResults.success++;
    } else {
      peer.challengeResults.fail++;
    }
  }

  /** Get total peer count. */
  getPeerCount(): number {
    return this.peers.size;
  }

  /** Get all known peers. */
  getAllPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /** Get a specific peer by username. */
  getPeer(username: string): PeerInfo | null {
    return this.peers.get(username) || null;
  }
}
