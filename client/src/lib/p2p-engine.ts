import Hls, { HlsConfig } from 'hls.js';
import { HlsJsP2PEngine } from 'p2p-media-loader-hlsjs';
import { SegmentCache, getSegmentCache } from './segment-cache';

export interface P2PStats {
  httpDownloaded: number;
  p2pDownloaded: number;
  p2pUploaded: number;
  peerCount: number;
  p2pRatio: number;
}

export interface P2PEngineConfig {
  enabled: boolean;
  swarmId?: string;
  trackerUrls?: string[];
  stunServers?: string[];
  onStats?: (stats: P2PStats) => void;
  onPeerConnect?: (peerId: string) => void;
  onPeerDisconnect?: (peerId: string) => void;
}

const DEFAULT_CONFIG: Partial<P2PEngineConfig> = {
  enabled: true,
  trackerUrls: [
    'wss://tracker.novage.com.ua',
    'wss://tracker.webtorrent.dev',
  ],
  stunServers: [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ],
};

export class P2PVideoEngine {
  private hls: Hls | null = null;
  private p2pEngine: any = null;
  private config: P2PEngineConfig;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private peerId: string;
  private segmentCache: SegmentCache | null = null;
  private currentStats: P2PStats = {
    httpDownloaded: 0,
    p2pDownloaded: 0,
    p2pUploaded: 0,
    peerCount: 0,
    p2pRatio: 0,
  };

  constructor(config: Partial<P2PEngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config } as P2PEngineConfig;
    this.peerId = this.generatePeerId();

    // Initialize segment cache for persistent storage
    if (this.config.enabled) {
      try {
        this.segmentCache = getSegmentCache();
        this.segmentCache.initialize().catch(() => {});
      } catch {
        // Segment cache not available — continue without it
      }
    }
  }

  private generatePeerId(): string {
    return `spk-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  isSupported(): boolean {
    return Hls.isSupported();
  }

  getPeerId(): string {
    return this.peerId;
  }

  getStats(): P2PStats {
    return { ...this.currentStats };
  }

  async attachToVideo(
    videoElement: HTMLVideoElement,
    manifestUrl: string
  ): Promise<void> {
    if (!Hls.isSupported()) {
      console.warn('[P2P Engine] HLS.js not supported, falling back to native');
      if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        videoElement.src = manifestUrl;
      }
      return;
    }

    this.cleanup();

    if (this.config.enabled) {
      await this.initWithP2P(videoElement, manifestUrl);
    } else {
      await this.initWithoutP2P(videoElement, manifestUrl);
    }
  }

  private async initWithP2P(
    videoElement: HTMLVideoElement,
    manifestUrl: string
  ): Promise<void> {
    const self = this;

    const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);

    const hlsConfig: Partial<HlsConfig> & { p2p?: any } = {
      liveSyncDurationCount: 7,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      p2p: {
        core: {
          swarmId: this.config.swarmId,
          announceTrackers: this.config.trackerUrls,
          simultaneousHttpDownloads: 2,
          simultaneousP2PDownloads: 5,
          cachedSegmentExpiration: 120000,
          cachedSegmentsCount: 50,
          rtcConfig: {
            iceServers: this.config.stunServers?.map(url => ({ urls: url })) || [
              { urls: 'stun:stun.l.google.com:19302' },
            ],
          },
        },
        onHlsJsCreated(hls: any) {
          self.p2pEngine = hls.p2pEngine;
          self.setupP2PEventListeners();
        },
      },
    };

    this.hls = new HlsWithP2P(hlsConfig) as unknown as Hls;
    this.setupHlsEventListeners();
    this.startStatsTracking();

    this.hls.loadSource(manifestUrl);
    this.hls.attachMedia(videoElement);

    console.log('[P2P Engine] Initialized with P2P support');
  }

  private async initWithoutP2P(
    videoElement: HTMLVideoElement,
    manifestUrl: string
  ): Promise<void> {
    this.hls = new Hls({
      liveSyncDurationCount: 7,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
    });

    this.setupHlsEventListeners();
    this.hls.loadSource(manifestUrl);
    this.hls.attachMedia(videoElement);

    console.log('[P2P Engine] Initialized without P2P (CDN only)');
  }

  private setupHlsEventListeners(): void {
    if (!this.hls) return;

    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.log('[P2P Engine] Manifest parsed');
    });

    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.error('[P2P Engine] Fatal error:', data.type, data.details);
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.log('[P2P Engine] Trying to recover from network error');
            this.hls?.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.log('[P2P Engine] Trying to recover from media error');
            this.hls?.recoverMediaError();
            break;
          default:
            console.error('[P2P Engine] Unrecoverable error, destroying');
            this.cleanup();
            break;
        }
      }
    });

    // Cache HLS segments in IndexedDB for P2P persistence across sessions
    this.hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      if (this.segmentCache && data.frag?.url) {
        const response = (data as any).frag?.data || (data as any).payload;
        if (response) {
          const buf = response instanceof ArrayBuffer ? response : response.buffer;
          if (buf) {
            this.segmentCache.cacheSegment(
              data.frag.url,
              buf,
              this.config.swarmId || 'unknown'
            ).catch(() => {});
          }
        }
      }
    });
  }

  private setupP2PEventListeners(): void {
    if (!this.p2pEngine) return;

    this.p2pEngine.addEventListener('onPeerConnect', (details: any) => {
      console.log('[P2P Engine] Peer connected:', details?.peerId);
      this.config.onPeerConnect?.(details?.peerId || 'unknown');
    });

    this.p2pEngine.addEventListener('onPeerClose', (details: any) => {
      console.log('[P2P Engine] Peer disconnected:', details?.peerId);
      this.config.onPeerDisconnect?.(details?.peerId || 'unknown');
    });

    this.p2pEngine.addEventListener('onSegmentLoaded', (details: any) => {
      const bytesLength = details?.bytesLength || 0;
      const isP2P = details?.peerId !== undefined;

      if (isP2P) {
        this.currentStats.p2pDownloaded += bytesLength;
      } else {
        this.currentStats.httpDownloaded += bytesLength;
      }
      this.updateP2PRatio();
    });

    this.p2pEngine.addEventListener('onSegmentUploaded', (details: any) => {
      this.currentStats.p2pUploaded += details?.bytesLength || 0;
    });
  }

  private updateP2PRatio(): void {
    const total = this.currentStats.httpDownloaded + this.currentStats.p2pDownloaded;
    if (total > 0) {
      this.currentStats.p2pRatio = this.currentStats.p2pDownloaded / total;
    }
  }

  private startStatsTracking(): void {
    this.statsInterval = setInterval(() => {
      this.config.onStats?.(this.getStats());
    }, 1000);
  }

  /** Report final P2P stats to the server for contribution tracking */
  reportFinalStats(): void {
    if (this.currentStats.p2pUploaded === 0 && this.currentStats.p2pDownloaded === 0) return;

    const body = JSON.stringify({
      peerId: this.peerId,
      videoCid: this.config.swarmId || '',
      bytesUploaded: this.currentStats.p2pUploaded,
      bytesDownloaded: this.currentStats.httpDownloaded + this.currentStats.p2pDownloaded,
      p2pRatio: this.currentStats.p2pRatio,
    });

    // Use sendBeacon for reliability on page unload, fall back to fetch
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/p2p/report', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/p2p/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  }

  cleanup(): void {
    // Report stats before cleanup
    this.reportFinalStats();

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    this.p2pEngine = null;

    this.currentStats = {
      httpDownloaded: 0,
      p2pDownloaded: 0,
      p2pUploaded: 0,
      peerCount: 0,
      p2pRatio: 0,
    };

    console.log('[P2P Engine] Cleaned up');
  }

  static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  static formatRatio(ratio: number): string {
    return (ratio * 100).toFixed(1) + '%';
  }
}

export function createP2PEngine(config?: Partial<P2PEngineConfig>): P2PVideoEngine {
  return new P2PVideoEngine(config);
}
