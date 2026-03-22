/**
 * mdns-discovery.ts — Zero-config GPU node discovery on LAN
 *
 * Uses mDNS/Bonjour to broadcast "I'm a Spirit Bomb GPU node" and
 * discover other nodes on the same local network. No IPs to type,
 * no codes to enter — nodes find each other automatically.
 *
 * Like how Chromecast or AirPlay discovers devices on your network.
 */

import Bonjour, { type Service } from 'bonjour-service';

export interface DiscoveredNode {
  name: string;
  host: string;
  port: number;
  gpu: string;
  vramGb: number;
  nodeId: string;
  timestamp: number;
}

export class MdnsDiscovery {
  private bonjour: InstanceType<typeof Bonjour> | null = null;
  private published = false;
  private discovered = new Map<string, DiscoveredNode>();
  private onDiscoverCallback?: (node: DiscoveredNode) => void;
  private onLostCallback?: (nodeId: string) => void;
  private browser: any = null;

  /**
   * Start broadcasting this node and listening for peers.
   */
  start(opts: {
    nodeId: string;
    port: number;
    gpu: string;
    vramGb: number;
    onDiscover?: (node: DiscoveredNode) => void;
    onLost?: (nodeId: string) => void;
  }): void {
    this.onDiscoverCallback = opts.onDiscover;
    this.onLostCallback = opts.onLost;

    try {
      this.bonjour = new Bonjour();

      // Publish this node
      this.bonjour.publish({
        name: `spiritbomb-${opts.nodeId.slice(0, 12)}`,
        type: 'spiritbomb',
        port: opts.port,
        txt: {
          gpu: opts.gpu,
          vram: String(opts.vramGb),
          nodeId: opts.nodeId,
          version: '2.0.0',
        },
      });
      this.published = true;
      console.log(`[mDNS] Broadcasting: ${opts.gpu} (${opts.vramGb}GB) on port ${opts.port}`);

      // Browse for other Spirit Bomb nodes
      this.browser = this.bonjour.find({ type: 'spiritbomb' }, (service: Service) => {
        const nodeId = service.txt?.nodeId || service.name;
        if (nodeId === opts.nodeId) return; // Skip self

        const node: DiscoveredNode = {
          name: service.name,
          host: service.host || service.referer?.address || '',
          port: service.port,
          gpu: service.txt?.gpu || 'Unknown GPU',
          vramGb: parseInt(service.txt?.vram || '0'),
          nodeId,
          timestamp: Date.now(),
        };

        const isNew = !this.discovered.has(nodeId);
        this.discovered.set(nodeId, node);

        if (isNew) {
          console.log(`[mDNS] Discovered: ${node.gpu} (${node.vramGb}GB) at ${node.host}:${node.port}`);
          this.onDiscoverCallback?.(node);
        }
      });

    } catch (err) {
      console.error('[mDNS] Failed to start:', err);
    }
  }

  /**
   * Stop broadcasting and listening.
   */
  stop(): void {
    try {
      if (this.browser) {
        this.browser.stop();
        this.browser = null;
      }
      if (this.bonjour) {
        this.bonjour.unpublishAll();
        this.bonjour.destroy();
        this.bonjour = null;
      }
      this.published = false;
      this.discovered.clear();
      console.log('[mDNS] Stopped');
    } catch (err) {
      console.error('[mDNS] Error stopping:', err);
    }
  }

  /**
   * Get all currently discovered nodes.
   */
  getDiscoveredNodes(): DiscoveredNode[] {
    return Array.from(this.discovered.values());
  }

  /**
   * Check if we're actively broadcasting.
   */
  isPublished(): boolean {
    return this.published;
  }
}
