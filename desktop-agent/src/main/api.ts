import express, { Express, Request, Response } from 'express';
import * as http from 'http';
import * as crypto from 'crypto';
import axios from 'axios';
import { KuboManager } from './kubo';
import { ConfigStore } from './config';

export class ApiServer {
  private app: Express;
  private server: http.Server | null = null;
  private kubo: KuboManager;
  private config: ConfigStore;
  private port: number;

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
    
    // CORS for web app communication
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
      const config = this.config.getConfig();
      const earnings = this.config.getEarnings();

      res.json({
        running: this.kubo.isRunning(),
        peerId,
        stats,
        hiveUsername: config.hiveUsername,
        earnings,
        version: '1.0.0',
      });
    });

    // Get/Set configuration
    this.app.get('/api/config', (req: Request, res: Response) => {
      res.json(this.config.getConfig());
    });

    this.app.post('/api/config', (req: Request, res: Response) => {
      const { hiveUsername, autoStart } = req.body;
      this.config.setConfig({ hiveUsername, autoStart });
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

    // PoA Challenge endpoint - validators call this
    this.app.post('/api/challenge', async (req: Request, res: Response) => {
      const { cid, blockIndex, salt, validatorId } = req.body;

      if (!cid || blockIndex === undefined || !salt) {
        return res.status(400).json({ error: 'Missing required fields: cid, blockIndex, salt' });
      }

      const startTime = Date.now();

      try {
        // Get the file blocks
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

        // Fetch the actual block data
        const blockResponse = await axios.post(
          `${this.kubo.getApiUrl()}/api/v0/block/get?arg=${blockCid}`,
          null,
          { timeout: 2000, responseType: 'arraybuffer' }
        );

        // Compute proof: SHA256(salt + blockData)
        const hash = crypto.createHash('sha256');
        hash.update(salt);
        hash.update(Buffer.from(blockResponse.data));
        const proof = hash.digest('hex');

        const responseTime = Date.now() - startTime;

        // Record successful challenge
        const hbdEarned = 0.001; // Base earnings per challenge
        this.config.recordChallenge(true, hbdEarned);

        res.json({
          success: true,
          proof,
          blockCid,
          responseTime,
        });
      } catch (error: any) {
        // Record failed challenge
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

    // Autostart management
    this.app.get('/api/autostart', (req: Request, res: Response) => {
      const config = this.config.getConfig();
      res.json({ enabled: config.autoStart });
    });

    this.app.post('/api/autostart', (req: Request, res: Response) => {
      const { enabled } = req.body;
      this.config.setConfig({ autoStart: enabled });
      // TODO: Actually configure OS autostart
      res.json({ success: true, enabled });
    });
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
