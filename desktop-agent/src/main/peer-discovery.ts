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

    // Scan every 60 seconds
    this.scanInterval = setInterval(() => this.scanBlocks(), 60000);

    // Announce self immediately, then every 60 minutes
    await this.announceNode();
    this.announceInterval = setInterval(() => this.announceNode(), 60 * 60 * 1000);

    console.log(`[PeerDiscovery] Active with ${this.peers.size} known peers`);
  }

  /** Stop scanning and announcing. */
  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    console.log('[PeerDiscovery] Stopped');
  }

  /** Scan recent Hive blocks for hivepoa_node_announce operations. */
  private async scanBlocks(): Promise<void> {
    try {
      const headBlock = await this.hive.getHeadBlockNumber();

      // On first run, start from ~1 hour ago (1200 blocks at 3s each)
      if (this.lastScannedBlock === 0) {
        this.lastScannedBlock = Math.max(0, headBlock - 1200);
      }

      // Don't scan more than 100 blocks per poll (avoid overloading on large gaps)
      const startBlock = Math.max(this.lastScannedBlock + 1, headBlock - 100);
      const blocksToScan = headBlock - startBlock + 1;

      if (blocksToScan <= 0) return;

      for (let i = startBlock; i <= headBlock; i++) {
        try {
          const block = await this.hive.getBlock(i);
          if (!block || !block.transactions) continue;

          for (const tx of block.transactions) {
            for (const op of tx.operations) {
              if (op[0] === 'custom_json' && op[1].id === 'hivepoa_node_announce') {
                try {
                  const json = JSON.parse(op[1].json);
                  const author = op[1].required_posting_auths?.[0] || '';
                  if (author && json.type === 'announce') {
                    this.processAnnouncement(author, json, i);
                  }
                } catch {}
              }
            }
          }
        } catch (err: any) {
          // Individual block fetch failure — skip and continue
          if (!err.message?.includes('abort')) {
            console.error(`[PeerDiscovery] Block ${i} fetch error:`, err.message);
          }
        }
      }

      this.lastScannedBlock = headBlock;
      // Persist last scanned block
      (this.config as any).store?.set('lastScannedBlock', headBlock);

      // Prune stale peers
      this.pruneStale();

    } catch (err: any) {
      console.error('[PeerDiscovery] Block scan error:', err.message);
    }
  }

  /** Process a peer announcement from the blockchain. */
  private processAnnouncement(hiveUsername: string, json: any, blockNum: number): void {
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

      // Try to connect to the new peer via IPFS swarm
      this.connectToPeer(peer.peerId);
    }
  }

  /** Try to connect to a peer via IPFS swarm (for PubSub reachability). */
  private async connectToPeer(peerId: string): Promise<void> {
    if (!this.kuboApiUrl || !peerId) return;

    try {
      await axios.post(
        `${this.kuboApiUrl}/api/v0/swarm/connect?arg=/p2p/${peerId}`,
        null,
        { timeout: 10000 }
      );
      console.log(`[PeerDiscovery] Connected to peer ${peerId.slice(0, 12)}...`);
    } catch {
      // Connection failures are normal — peer may not be directly reachable
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
    const cutoff = Date.now() - (4 * 60 * 60 * 1000);
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
      if (now - peer.lastAnnounce > 4 * 60 * 60 * 1000) return false;
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
