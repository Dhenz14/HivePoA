import WebSocket from 'ws';
import axios from 'axios';
import { EventEmitter } from 'events';
import { KuboManager } from './kubo';
import { ConfigStore } from './config';
import { computeProofHash, getBlockCids, hashFile, hashString, getIntFromHash } from './poa-crypto';

export class AgentWSClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private kubo: KuboManager;
  private config: ConfigStore;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private nodeId: string | null = null;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private activeChallenges = 0;

  constructor(kubo: KuboManager, config: ConfigStore) {
    super();
    this.kubo = kubo;
    this.config = config;
  }

  connect(): void {
    const cfg = this.config.getConfig();
    if (!cfg.hiveUsername || !cfg.serverUrl) {
      console.log('[AgentWS] No hiveUsername or serverUrl configured, skipping connection');
      return;
    }

    if (!this.kubo.isRunning()) {
      console.log('[AgentWS] IPFS not running, deferring connection');
      return;
    }

    // Clean up any existing connection before creating a new one
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    // Clear any pending reconnect timer to prevent double-connect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const wsUrl = cfg.serverUrl.replace(/^http/, 'ws') + '/ws/agent';
    console.log(`[AgentWS] Connecting to ${wsUrl}...`);

    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[AgentWS] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', async () => {
      console.log('[AgentWS] Connected to server');
      this.reconnectDelay = 1000;
      this.reconnectAttempts = 0;

      // Send registration
      const peerId = await this.kubo.getPeerId();
      if (!peerId) {
        console.error('[AgentWS] Cannot register — no peer ID');
        return;
      }

      const registerMsg = {
        type: 'register',
        peerId,
        hiveUsername: cfg.hiveUsername,
        version: require('electron').app.getVersion(),
        storageMaxGB: cfg.storageMaxGB,
      };

      this.ws?.send(JSON.stringify(registerMsg));
      console.log(`[AgentWS] Sent registration as ${cfg.hiveUsername} (${peerId})`);

      this.startHeartbeat();
    });

    this.ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(message);
      } catch (err) {
        console.error('[AgentWS] Failed to parse message:', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[AgentWS] Disconnected (code=${code}, reason=${reason})`);
      this.stopHeartbeat();
      this.ws = null;
      this.emit('disconnected');

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[AgentWS] WebSocket error:', err.message);
      // close event will fire after this, triggering reconnect
    });
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'registered':
        this.nodeId = message.nodeId;
        console.log(`[AgentWS] Registered! nodeId=${this.nodeId}: ${message.message}`);
        this.emit('connected');
        break;

      case 'RequestProof':
        await this.handleChallenge(message);
        break;

      case 'error':
        console.error(`[AgentWS] Server error: ${message.message}`);
        break;

      default:
        console.log(`[AgentWS] Unknown message type: ${message.type}`);
    }
  }

  private async handleChallenge(challenge: { Hash: string; CID: string; User: string }): Promise<void> {
    const { Hash: salt, CID: cid, User: validator } = challenge;
    console.log(`[AgentWS] Challenge received: CID=${cid}, validator=${validator}`);

    const startTime = Date.now();
    const CHALLENGE_TIMEOUT = 24_000; // Must respond within 25s server-side; give 1s network buffer
    this.activeChallenges++;

    try {
      // Race proof computation against a timeout
      const kuboApiUrl = this.kubo.getApiUrl();
      const proofPromise = (async () => {
        const blockCids = await getBlockCids(kuboApiUrl, cid);
        return await computeProofHash(kuboApiUrl, salt, cid, blockCids);
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('PROOF_TIMEOUT')), CHALLENGE_TIMEOUT);
      });

      const proofHash = await Promise.race([proofPromise, timeoutPromise]);

      const elapsed = Date.now() - startTime;
      console.log(`[AgentWS] Proof computed in ${elapsed}ms: ${proofHash.slice(0, 16)}...`);

      this.ws?.send(JSON.stringify({
        type: 'ProofResponse',
        Hash: salt,
        CID: cid,
        Status: 'Success',
        proofHash,
        elapsed,
      }));

      this.config.recordChallenge(true, 0.001);

    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      console.error(`[AgentWS] Challenge failed: ${err.message}`);

      this.ws?.send(JSON.stringify({
        type: 'ProofResponse',
        Hash: salt,
        CID: cid,
        Status: 'Fail',
        error: err.message,
        elapsed,
      }));

      this.config.recordChallenge(false, 0);
    } finally {
      this.activeChallenges = Math.max(0, this.activeChallenges - 1);
    }
  }

  hasActiveChallenges(): boolean {
    return this.activeChallenges > 0;
  }

  // Proof computation delegated to shared poa-crypto module.
  // getBlockCids, computeProofHash, getIntFromHash, hashFile, hashString
  // are all imported from './poa-crypto'.

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;

    this.reconnectAttempts++;
    console.log(`[AgentWS] Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client shutdown');
      this.ws = null;
    }
  }

  /**
   * Reconnect with new server URL (called after config change).
   */
  reconnectToServer(): void {
    this.disconnect();
    setTimeout(() => this.connect(), 500);
  }

  getConnectionStatus(): { connected: boolean; reconnectAttempts: number; nodeId: string | null } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      reconnectAttempts: this.reconnectAttempts,
      nodeId: this.nodeId,
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
