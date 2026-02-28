/**
 * Auto-Pinner — Automatically pins popular content from the P2P network
 *
 * Desktop agents are always-on IPFS nodes. By pinning content that's popular
 * (many viewers currently watching), they act as permanent CDN seeds for videos
 * that would otherwise only be served by transient browser peers.
 */
import axios from 'axios';

interface PopularCid {
  cid: string;
  activePeers: number;
  totalBytesShared: number;
}

export class AutoPinner {
  private kuboApiUrl: string;
  private serverUrl: string;
  private maxAutoPinBytes: number;
  private enabled: boolean;
  private pollInterval: NodeJS.Timeout | null = null;
  private pinnedCids: Set<string> = new Set();
  private autoPinnedCids: Set<string> = new Set();
  private currentAutoPinSize: number = 0;

  constructor(kuboApiUrl: string, serverUrl: string, maxAutoPinGB: number = 10) {
    this.kuboApiUrl = kuboApiUrl;
    this.serverUrl = serverUrl;
    this.maxAutoPinBytes = maxAutoPinGB * 1024 * 1024 * 1024;
    this.enabled = true;
  }

  async start(): Promise<void> {
    await this.refreshPinnedList();
    // Poll every 5 minutes
    this.pollInterval = setInterval(() => this.checkAndPin(), 300000);
    // First check after 30 seconds (let IPFS stabilize)
    setTimeout(() => this.checkAndPin(), 30000);
    console.log(`[AutoPinner] Started (max: ${Math.round(this.maxAutoPinBytes / (1024 * 1024 * 1024))}GB)`);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getStats(): { autoPinned: number; enabled: boolean } {
    return {
      autoPinned: this.autoPinnedCids.size,
      enabled: this.enabled,
    };
  }

  private async checkAndPin(): Promise<void> {
    if (!this.enabled) return;

    try {
      const res = await axios.get(`${this.serverUrl}/api/p2p/popular`, {
        timeout: 10000,
        params: { limit: 20 },
      });
      const popular: PopularCid[] = res.data || [];

      // Filter to CIDs we don't already have
      const toPin = popular.filter(p => p.cid && !this.pinnedCids.has(p.cid));

      // Pin up to 3 new CIDs per cycle
      for (const item of toPin.slice(0, 3)) {
        if (this.autoPinnedCids.size >= 100) break;

        try {
          await axios.post(
            `${this.kuboApiUrl}/api/v0/pin/add?arg=${item.cid}`,
            null,
            { timeout: 120000 }
          );
          this.pinnedCids.add(item.cid);
          this.autoPinnedCids.add(item.cid);
          console.log(`[AutoPinner] Pinned popular CID: ${item.cid} (${item.activePeers} peers)`);
        } catch (err: any) {
          console.warn(`[AutoPinner] Failed to pin ${item.cid}: ${err.message}`);
        }
      }
    } catch {
      // Server unreachable — not critical, will retry next cycle
    }
  }

  private async refreshPinnedList(): Promise<void> {
    try {
      const res = await axios.post(
        `${this.kuboApiUrl}/api/v0/pin/ls?type=recursive`,
        null,
        { timeout: 10000 }
      );
      this.pinnedCids = new Set(Object.keys(res.data?.Keys || {}));
    } catch {
      // IPFS not ready yet — will retry
    }
  }
}
