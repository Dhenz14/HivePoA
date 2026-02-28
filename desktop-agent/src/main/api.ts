import express, { Express, Request, Response } from 'express';
import * as http from 'http';
import * as crypto from 'crypto';
import axios from 'axios';
import { app as electronApp } from 'electron';
import { KuboManager } from './kubo';
import { ConfigStore, AgentConfig } from './config';
import type { AgentWSClient } from './agent-ws';
import type { PeerDiscovery } from './peer-discovery';
import type { LocalValidator } from './validator';
import type { ChallengeHandler } from './challenge-handler';

export class ApiServer {
  private app: Express;
  private server: http.Server | null = null;
  private kubo: KuboManager;
  private config: ConfigStore;
  private port: number;
  private agentWS: AgentWSClient | null = null;

  // P2P modules
  private peerDiscovery: PeerDiscovery | null = null;
  private validator: LocalValidator | null = null;
  private challengeHandler: ChallengeHandler | null = null;

  constructor(kubo: KuboManager, config: ConfigStore) {
    this.kubo = kubo;
    this.config = config;
    this.port = config.getConfig().apiPort;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // CORS — allow localhost origins + file:// (Electron renderer sends null origin)
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5000',
      'http://localhost:8080',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5000',
      'http://127.0.0.1:8080',
    ];
    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Name');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });
  }

  private setupRoutes(): void {
    // Health check - used by web app to detect desktop agent
    this.app.get('/api/status', async (req: Request, res: Response) => {
      const peerId = await this.kubo.getPeerId();
      const stats = await this.kubo.getStats();
      const storageInfo = await this.kubo.getStorageInfo();
      const configData = this.config.getConfig();
      const earnings = this.config.getEarnings();

      res.json({
        running: this.kubo.isRunning(),
        peerId,
        stats,
        storageInfo,
        config: {
          hiveUsername: configData.hiveUsername,
          autoStart: configData.autoStart,
          bandwidthLimitUp: configData.bandwidthLimitUp,
          bandwidthLimitDown: configData.bandwidthLimitDown,
          storageMaxGB: configData.storageMaxGB,
          serverUrl: configData.serverUrl,
          p2pMode: configData.p2pMode,
          validatorEnabled: configData.validatorEnabled,
          challengeIntervalMs: configData.challengeIntervalMs,
        },
        // P2P network status
        network: {
          p2pMode: configData.p2pMode,
          peerCount: this.peerDiscovery?.getPeerCount() || 0,
          validatorEnabled: configData.validatorEnabled,
          validationStats: this.validator?.getStats() || { issued: 0, passed: 0, failed: 0, timeouts: 0 },
          hasPostingKey: this.config.hasPostingKey(),
        },
        // Legacy server connection (for backward compatibility)
        serverConnection: this.agentWS?.getConnectionStatus() || { connected: false, reconnectAttempts: 0 },
        earnings,
        version: electronApp.getVersion(),
      });
    });

    // Get/Set configuration
    this.app.get('/api/config', (req: Request, res: Response) => {
      res.json(this.config.getConfig());
    });

    this.app.post('/api/config', async (req: Request, res: Response) => {
      const {
        hiveUsername, autoStart, bandwidthLimitUp, bandwidthLimitDown,
        storageMaxGB, serverUrl, p2pMode, validatorEnabled, challengeIntervalMs,
      } = req.body;

      // Input validation for numeric fields
      if (bandwidthLimitUp !== undefined) {
        const val = Number(bandwidthLimitUp);
        if (!Number.isFinite(val) || val < 0 || val > 1000000) {
          return res.status(400).json({ error: 'bandwidthLimitUp must be 0-1000000 KB/s' });
        }
      }
      if (bandwidthLimitDown !== undefined) {
        const val = Number(bandwidthLimitDown);
        if (!Number.isFinite(val) || val < 0 || val > 1000000) {
          return res.status(400).json({ error: 'bandwidthLimitDown must be 0-1000000 KB/s' });
        }
      }
      if (storageMaxGB !== undefined) {
        const val = Number(storageMaxGB);
        if (!Number.isFinite(val) || val < 0 || val > 10000) {
          return res.status(400).json({ error: 'storageMaxGB must be 0-10000' });
        }
      }

      const updates: Partial<AgentConfig> = {};
      if (hiveUsername !== undefined) updates.hiveUsername = hiveUsername;
      if (autoStart !== undefined) updates.autoStart = autoStart;
      if (bandwidthLimitUp !== undefined) updates.bandwidthLimitUp = Number(bandwidthLimitUp);
      if (bandwidthLimitDown !== undefined) updates.bandwidthLimitDown = Number(bandwidthLimitDown);
      if (storageMaxGB !== undefined) updates.storageMaxGB = Number(storageMaxGB);
      if (serverUrl !== undefined) updates.serverUrl = serverUrl;
      if (p2pMode !== undefined) updates.p2pMode = p2pMode;
      if (validatorEnabled !== undefined) updates.validatorEnabled = validatorEnabled;
      if (challengeIntervalMs !== undefined) updates.challengeIntervalMs = Number(challengeIntervalMs);

      this.config.setConfig(updates);

      // Apply IPFS config changes if needed
      let needsRestart = false;
      if (bandwidthLimitUp !== undefined || bandwidthLimitDown !== undefined) {
        const cfg = this.config.getConfig();
        needsRestart = this.kubo.applyBandwidthConfig(cfg.bandwidthLimitUp, cfg.bandwidthLimitDown);
      }
      if (storageMaxGB !== undefined) {
        needsRestart = this.kubo.applyStorageQuota(storageMaxGB) || needsRestart;
      }
      if (needsRestart && this.kubo.isRunning()) {
        // Defer restart if challenges are in-flight
        const hasActive = this.agentWS?.hasActiveChallenges() ||
          (this.challengeHandler && !this.challengeHandler.hasCapacity());
        if (hasActive) {
          console.log('[API] Config saved, but deferring IPFS restart — challenge in progress');
          res.json({ success: true, config: this.config.getConfig(), restartDeferred: true });
          return;
        }
        try {
          await this.kubo.restart();
        } catch (error: any) {
          return res.status(500).json({ error: 'Failed to restart IPFS: ' + error.message });
        }
      }

      // Legacy: Reconnect WebSocket if server URL or username changed
      if ((serverUrl !== undefined || hiveUsername !== undefined) && this.agentWS) {
        this.agentWS.reconnectToServer();
      }

      res.json({ success: true, config: this.config.getConfig() });
    });

    // Pin content
    this.app.post('/api/pin', async (req: Request, res: Response) => {
      const { cid } = req.body;
      if (!cid) {
        return res.status(400).json({ error: 'CID required' });
      }

      try {
        const response = await axios.post(
          `${this.kubo.getApiUrl()}/api/v0/pin/add?arg=${cid}`,
          null,
          { timeout: 300000 }
        );
        res.json({ success: true, pins: response.data.Pins });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Unpin content
    this.app.post('/api/unpin', async (req: Request, res: Response) => {
      const { cid } = req.body;
      if (!cid) {
        return res.status(400).json({ error: 'CID required' });
      }

      try {
        await axios.post(`${this.kubo.getApiUrl()}/api/v0/pin/rm?arg=${cid}`);
        res.json({ success: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Upload file directly to IPFS (add + pin in one step)
    this.app.post('/api/upload', express.raw({ type: '*/*', limit: '500mb' }), async (req: Request, res: Response) => {
      const fileBuffer = req.body as Buffer;
      if (!fileBuffer || fileBuffer.length === 0) {
        return res.status(400).json({ error: 'No file data provided' });
      }

      const fileName = (req.headers['x-file-name'] as string) || 'upload';

      try {
        // Construct multipart form data for Kubo /api/v0/add
        const boundary = '----IPFSUpload' + Date.now();
        const header = Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
        );
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([header, fileBuffer, footer]);

        const response = await axios.post(
          `${this.kubo.getApiUrl()}/api/v0/add?pin=true&cid-version=1`,
          body,
          {
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            timeout: 300000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }
        );

        const cid = response.data.Hash;
        console.log(`[API] Uploaded file "${fileName}" → ${cid}`);
        res.json({ success: true, cid, name: fileName, size: fileBuffer.length });
      } catch (error: any) {
        console.error('[API] Upload failed:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // List pinned content
    this.app.get('/api/pins', async (req: Request, res: Response) => {
      try {
        const response = await axios.post(`${this.kubo.getApiUrl()}/api/v0/pin/ls?type=recursive`);
        const pins = Object.keys(response.data.Keys || {});
        res.json({ pins });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // PoA Challenge endpoint - validators call this (legacy HTTP mode)
    this.app.post('/api/challenge', async (req: Request, res: Response) => {
      const { cid, blockIndex, salt, validatorId } = req.body;

      if (!cid || blockIndex === undefined || !salt) {
        return res.status(400).json({ error: 'Missing required fields: cid, blockIndex, salt' });
      }

      const startTime = Date.now();

      try {
        const blocksResponse = await axios.post(
          `${this.kubo.getApiUrl()}/api/v0/refs?arg=${cid}`,
          null,
          { timeout: 2000 }
        );

        const blocks = blocksResponse.data.split('\n')
          .filter((line: string) => line.trim())
          .map((line: string) => {
            try { return JSON.parse(line).Ref; } catch { return null; }
          })
          .filter(Boolean);

        if (blockIndex >= blocks.length) {
          return res.status(400).json({ error: 'Block index out of range' });
        }

        const blockCid = blocks[blockIndex];
        const blockResponse = await axios.post(
          `${this.kubo.getApiUrl()}/api/v0/block/get?arg=${blockCid}`,
          null,
          { timeout: 2000, responseType: 'arraybuffer' }
        );

        const hash = crypto.createHash('sha256');
        hash.update(salt);
        hash.update(Buffer.from(blockResponse.data));
        const proof = hash.digest('hex');

        const responseTime = Date.now() - startTime;
        const hbdEarned = 0.001;
        this.config.recordChallenge(true, hbdEarned);

        res.json({ success: true, proof, blockCid, responseTime });
      } catch (error: any) {
        this.config.recordChallenge(false, 0);
        res.status(500).json({
          success: false,
          error: error.message,
          responseTime: Date.now() - startTime,
        });
      }
    });

    // Get earnings
    this.app.get('/api/earnings', (req: Request, res: Response) => {
      res.json(this.config.getEarnings());
    });

    // Connection/network status
    this.app.get('/api/connection-status', (req: Request, res: Response) => {
      const cfg = this.config.getConfig();
      if (cfg.p2pMode) {
        res.json({
          p2pMode: true,
          peerCount: this.peerDiscovery?.getPeerCount() || 0,
          validatorEnabled: cfg.validatorEnabled,
          validationStats: this.validator?.getStats() || { issued: 0, passed: 0, failed: 0, timeouts: 0 },
        });
      } else {
        res.json(this.agentWS?.getConnectionStatus() || { connected: false, reconnectAttempts: 0 });
      }
    });

    // P2P Peers list
    this.app.get('/api/peers', (req: Request, res: Response) => {
      const peers = this.peerDiscovery?.getAllPeers() || [];
      res.json({ peers, count: peers.length });
    });

    // Validation stats
    this.app.get('/api/validation/stats', (req: Request, res: Response) => {
      res.json(this.validator?.getStats() || { issued: 0, passed: 0, failed: 0, timeouts: 0 });
    });

    // Toggle validation
    this.app.post('/api/validation/toggle', (req: Request, res: Response) => {
      const { enabled } = req.body;
      this.config.setConfig({ validatorEnabled: !!enabled });
      res.json({ success: true, validatorEnabled: !!enabled });
    });

    // Posting key management
    this.app.post('/api/hive/posting-key', (req: Request, res: Response) => {
      const { key } = req.body;
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: 'Posting key required' });
      }
      this.config.setPostingKey(key);
      res.json({ success: true, hasPostingKey: true });
    });

    this.app.delete('/api/hive/posting-key', (req: Request, res: Response) => {
      this.config.clearPostingKey();
      res.json({ success: true, hasPostingKey: false });
    });

    // Autostart management
    this.app.get('/api/autostart', (req: Request, res: Response) => {
      const config = this.config.getConfig();
      res.json({ enabled: config.autoStart });
    });

    this.app.post('/api/autostart', (req: Request, res: Response) => {
      const { enabled } = req.body;
      this.config.setConfig({ autoStart: enabled });

      try {
        electronApp.setLoginItemSettings({
          openAtLogin: !!enabled,
          name: 'SPK Desktop Agent',
        });
        console.log(`[API] Autostart ${enabled ? 'enabled' : 'disabled'}`);
      } catch (error) {
        console.error('[API] Failed to configure autostart:', error);
      }

      res.json({ success: true, enabled });
    });
  }

  setAgentWS(agentWS: AgentWSClient): void {
    this.agentWS = agentWS;
  }

  setP2PModules(
    peerDiscovery: PeerDiscovery,
    validator: LocalValidator | null,
    challengeHandler: ChallengeHandler
  ): void {
    this.peerDiscovery = peerDiscovery;
    this.validator = validator;
    this.challengeHandler = challengeHandler;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, '127.0.0.1', () => {
          console.log(`[API] Server listening on http://127.0.0.1:${this.port}`);
          resolve();
        });

        this.server.on('error', (error: any) => {
          if (error.code === 'EADDRINUSE') {
            console.log(`[API] Port ${this.port} in use, trying ${this.port + 1}`);
            this.port++;
            this.server = this.app.listen(this.port, '127.0.0.1', () => {
              resolve();
            });
          } else {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[API] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
