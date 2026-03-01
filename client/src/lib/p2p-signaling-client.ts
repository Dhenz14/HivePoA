import { getBackendMode } from './api-mode';

type MessageHandler = (message: any) => void;

interface P2PSignalingClientOptions {
  onPeerList?: MessageHandler;
  onOffer?: MessageHandler;
  onAnswer?: MessageHandler;
  onIceCandidate?: MessageHandler;
  onError?: MessageHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export class P2PSignalingClient {
  private ws: WebSocket | null = null;
  private peerId: string;
  private videoCid: string | null = null;
  private hiveUsername?: string;
  private isDesktopAgent: boolean;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private handlers: P2PSignalingClientOptions;
  private isConnected = false;
  private shouldReconnect = true;

  constructor(options: P2PSignalingClientOptions = {}) {
    this.peerId = this.generatePeerId();
    this.isDesktopAgent = this.detectDesktopAgent();
    this.handlers = options;
  }

  private generatePeerId(): string {
    return `peer-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private detectDesktopAgent(): boolean {
    return typeof window !== 'undefined' && 
           (window as any).__TAURI__ !== undefined;
  }

  connect(url?: string) {
    const mode = getBackendMode();
    if (mode === 'standalone') {
      // No backend — skip signaling entirely, P2P works via public trackers
      this.shouldReconnect = false;
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const wsUrl = url || this.getDefaultWsUrl();
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[P2P Signaling] Connected');
      this.isConnected = true;
      this.startHeartbeat();
      this.handlers.onConnect?.();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      console.log('[P2P Signaling] Disconnected');
      this.isConnected = false;
      this.stopHeartbeat();
      this.handlers.onDisconnect?.();
      
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error('[P2P Signaling] Error:', error);
    };
  }

  private getDefaultWsUrl(): string {
    const mode = getBackendMode();
    if (mode === 'agent') {
      return 'ws://127.0.0.1:5111/p2p';
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/p2p`;
  }

  private handleMessage(data: string) {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'peer-list':
          this.handlers.onPeerList?.(message);
          break;
        case 'offer':
          this.handlers.onOffer?.(message);
          break;
        case 'answer':
          this.handlers.onAnswer?.(message);
          break;
        case 'ice-candidate':
          this.handlers.onIceCandidate?.(message);
          break;
        case 'error':
          console.error('[P2P Signaling] Server error:', message.payload?.message);
          this.handlers.onError?.(message);
          break;
        case 'heartbeat':
          break;
      }
    } catch (error) {
      console.error('[P2P Signaling] Failed to parse message:', error);
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.reconnectTimeout = setTimeout(() => {
      console.log('[P2P Signaling] Attempting reconnect...');
      this.connect();
    }, 3000);
  }

  joinRoom(videoCid: string, hiveUsername?: string) {
    this.videoCid = videoCid;
    this.hiveUsername = hiveUsername;
    
    this.send({
      type: 'join',
      peerId: this.peerId,
      videoCid,
      hiveUsername,
      isDesktopAgent: this.isDesktopAgent,
    });
  }

  leaveRoom() {
    this.send({ type: 'leave' });
    this.videoCid = null;
  }

  sendOffer(targetPeerId: string, offer: RTCSessionDescriptionInit) {
    this.send({
      type: 'offer',
      targetPeerId,
      payload: offer,
    });
  }

  sendAnswer(targetPeerId: string, answer: RTCSessionDescriptionInit) {
    this.send({
      type: 'answer',
      targetPeerId,
      payload: answer,
    });
  }

  sendIceCandidate(targetPeerId: string, candidate: RTCIceCandidate) {
    this.send({
      type: 'ice-candidate',
      targetPeerId,
      payload: candidate.toJSON(),
    });
  }

  updateStats(stats: {
    bytesUploaded: number;
    bytesDownloaded: number;
    segmentsShared: number;
    peersConnected: number;
  }) {
    this.send({
      type: 'stats-update',
      payload: stats,
    });
  }

  private send(message: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getPeerId(): string {
    return this.peerId;
  }

  getVideoCid(): string | null {
    return this.videoCid;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  setHiveUsername(username: string) {
    this.hiveUsername = username;
  }
}

let signalingClient: P2PSignalingClient | null = null;

export function getP2PSignalingClient(options?: P2PSignalingClientOptions): P2PSignalingClient {
  if (!signalingClient) {
    signalingClient = new P2PSignalingClient(options);
  }
  return signalingClient;
}
